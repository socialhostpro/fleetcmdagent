"""
LLM Monitor API - Proxy to the LLM Monitor service for attention visualization.

Routes requests to the dedicated llm-monitor service running on port 8766.
"""

import os
import json
import asyncio
from typing import Optional, List, Dict, Any

import httpx
import redis.asyncio as redis
from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from config import settings

router = APIRouter()
r = redis.from_url(settings.REDIS_URL, decode_responses=True)

LLM_MONITOR_URL = os.getenv("LLM_MONITOR_URL", "http://fleet-llm-monitor:8766")


# ----- Request/Response Models -----

class MonitorSessionRequest(BaseModel):
    prompt: str
    backend: str = "ollama"
    model: str = "llama3.2"
    extract_attention: bool = True
    extract_embeddings: bool = True


class MonitorSessionResponse(BaseModel):
    session_id: str
    status: str


class BackendInfo(BaseModel):
    name: str
    url: str
    status: str
    models: List[str]


class PerformanceMetrics(BaseModel):
    tokens_per_second: float
    latency_ms: float
    memory_mb: float
    gpu_utilization: Optional[float] = None


# ----- Endpoints -----

@router.get("/health")
async def health():
    """Check LLM Monitor service health."""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{LLM_MONITOR_URL}/health")
            if resp.status_code == 200:
                return resp.json()
            return {"status": "degraded", "detail": f"Monitor returned {resp.status_code}"}
    except Exception as e:
        return {"status": "offline", "error": str(e)}


@router.get("/backends", response_model=List[BackendInfo])
async def list_backends():
    """List available LLM backends."""
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(f"{LLM_MONITOR_URL}/backends")
            if resp.status_code == 200:
                return resp.json()
            raise HTTPException(status_code=resp.status_code, detail="Failed to get backends")
    except httpx.RequestError as e:
        raise HTTPException(status_code=503, detail=f"LLM Monitor unavailable: {e}")


@router.post("/session/start", response_model=MonitorSessionResponse)
async def start_session(request: MonitorSessionRequest):
    """Start a new LLM monitoring session."""
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                f"{LLM_MONITOR_URL}/session/start",
                json=request.model_dump()
            )
            if resp.status_code == 200:
                return resp.json()
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
    except httpx.RequestError as e:
        raise HTTPException(status_code=503, detail=f"LLM Monitor unavailable: {e}")


@router.get("/session/{session_id}/status")
async def get_session_status(session_id: str):
    """Get status of a monitoring session."""
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(f"{LLM_MONITOR_URL}/session/{session_id}/status")
            if resp.status_code == 200:
                return resp.json()
            elif resp.status_code == 404:
                raise HTTPException(status_code=404, detail="Session not found")
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
    except httpx.RequestError as e:
        raise HTTPException(status_code=503, detail=f"LLM Monitor unavailable: {e}")


@router.get("/session/{session_id}/attention")
async def get_attention(session_id: str, layer: Optional[int] = None):
    """Get attention data for a session."""
    try:
        params = {"layer": layer} if layer is not None else {}
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.get(
                f"{LLM_MONITOR_URL}/session/{session_id}/attention",
                params=params
            )
            if resp.status_code == 200:
                return resp.json()
            elif resp.status_code == 404:
                raise HTTPException(status_code=404, detail="Session not found")
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
    except httpx.RequestError as e:
        raise HTTPException(status_code=503, detail=f"LLM Monitor unavailable: {e}")


@router.get("/session/{session_id}/embeddings")
async def get_embeddings(session_id: str, dimensions: int = 2):
    """Get projected embeddings for visualization."""
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.get(
                f"{LLM_MONITOR_URL}/session/{session_id}/embeddings",
                params={"dimensions": dimensions}
            )
            if resp.status_code == 200:
                return resp.json()
            elif resp.status_code == 404:
                raise HTTPException(status_code=404, detail="Session not found")
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
    except httpx.RequestError as e:
        raise HTTPException(status_code=503, detail=f"LLM Monitor unavailable: {e}")


@router.get("/metrics/performance", response_model=PerformanceMetrics)
async def get_performance_metrics():
    """Get aggregated performance metrics."""
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(f"{LLM_MONITOR_URL}/metrics/performance")
            if resp.status_code == 200:
                return resp.json()
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
    except httpx.RequestError as e:
        raise HTTPException(status_code=503, detail=f"LLM Monitor unavailable: {e}")


# ----- WebSocket Proxy -----

@router.websocket("/ws/monitor/{session_id}")
async def websocket_monitor_proxy(websocket: WebSocket, session_id: str):
    """
    WebSocket proxy to LLM Monitor service.
    Subscribes to Redis pub/sub for real-time attention streaming.
    """
    await websocket.accept()

    pubsub = r.pubsub()
    channel = f"llm-monitor:{session_id}"

    try:
        await pubsub.subscribe(channel)
        await websocket.send_json({
            "type": "connected",
            "session_id": session_id
        })

        while True:
            try:
                # Check for Redis messages
                message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=0.5)
                if message and message['type'] == 'message':
                    data = json.loads(message['data'])
                    await websocket.send_json(data)

                    # Check for completion
                    if data.get("status") == "completed" or data.get("error"):
                        break

                # Check for client messages (ping/disconnect)
                try:
                    client_msg = await asyncio.wait_for(websocket.receive_text(), timeout=0.1)
                    if client_msg == "ping":
                        await websocket.send_json({"type": "pong"})
                except asyncio.TimeoutError:
                    pass

            except WebSocketDisconnect:
                break

    except Exception as e:
        try:
            await websocket.send_json({"error": str(e)})
        except:
            pass
    finally:
        await pubsub.unsubscribe(channel)
