"""
LLM Monitor Service - Real-time transformer visualization proxy

Extracts attention patterns, embeddings, and performance metrics from LLM backends.
Uses GPT-2 as a proxy model to extract attention weights since Ollama/TensorRT
don't expose internal attention matrices.
"""

import asyncio
import json
import time
import uuid
from typing import Dict, List, Optional
from contextlib import asynccontextmanager

import httpx
import numpy as np
import redis.asyncio as redis
import torch
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from transformers import GPT2LMHeadModel, GPT2Tokenizer

from extractors.ollama import OllamaExtractor
from utils.compression import compress_attention
from utils.sampling import downsample_embeddings


# ----- Models -----

class SessionStartRequest(BaseModel):
    prompt: str
    backend: str = "ollama"
    model: str = "llama3.2"
    extract_attention: bool = True
    extract_embeddings: bool = True


class SessionResponse(BaseModel):
    session_id: str
    status: str


class TokenData(BaseModel):
    token_id: int
    token: str
    position: int
    logprob: Optional[float] = None


class AttentionHead(BaseModel):
    layer: int
    head: int
    weights: List[List[float]]  # [seq_len, seq_len] sparse matrix


class AttentionSnapshot(BaseModel):
    timestamp: float
    tokens: List[TokenData]
    attention_heads: List[AttentionHead]
    current_position: int


class PerformanceMetrics(BaseModel):
    tokens_per_second: float
    latency_ms: float
    memory_mb: float
    gpu_utilization: Optional[float] = None


class BackendInfo(BaseModel):
    name: str
    url: str
    status: str
    models: List[str]


# ----- Globals -----

redis_client: Optional[redis.Redis] = None
gpt2_model: Optional[GPT2LMHeadModel] = None
gpt2_tokenizer: Optional[GPT2Tokenizer] = None
active_sessions: Dict[str, dict] = {}
extractors: Dict[str, object] = {}


# ----- Lifespan -----

@asynccontextmanager
async def lifespan(app: FastAPI):
    global redis_client, gpt2_model, gpt2_tokenizer, extractors

    # Initialize Redis
    redis_url = "redis://comfyui-redis:6379"
    try:
        redis_client = redis.from_url(redis_url, decode_responses=True)
        await redis_client.ping()
        print(f"Connected to Redis at {redis_url}")
    except Exception as e:
        print(f"Redis connection failed: {e}, running without pub/sub")
        redis_client = None

    # Load GPT-2 for attention extraction
    print("Loading GPT-2 model for attention extraction...")
    device = "cuda" if torch.cuda.is_available() else "cpu"
    gpt2_tokenizer = GPT2Tokenizer.from_pretrained("gpt2")
    gpt2_model = GPT2LMHeadModel.from_pretrained("gpt2").to(device)
    gpt2_model.eval()
    print(f"GPT-2 loaded on {device}")

    # Initialize extractors
    ollama_url = "http://jessica-ollama-gb10:11434"
    extractors["ollama"] = OllamaExtractor(ollama_url, gpt2_model, gpt2_tokenizer)

    yield

    # Cleanup
    if redis_client:
        await redis_client.close()


# ----- App -----

app = FastAPI(
    title="LLM Monitor",
    description="Real-time LLM visualization and monitoring",
    version="1.0.0",
    lifespan=lifespan
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ----- Endpoints -----

@app.get("/health")
async def health():
    return {
        "status": "healthy",
        "gpu_available": torch.cuda.is_available(),
        "active_sessions": len(active_sessions)
    }


@app.get("/backends", response_model=List[BackendInfo])
async def list_backends():
    """List available LLM backends and their status"""
    backends = []

    # Check Ollama
    ollama_url = "http://jessica-ollama-gb10:11434"
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{ollama_url}/api/tags")
            if resp.status_code == 200:
                models = [m["name"] for m in resp.json().get("models", [])]
                backends.append(BackendInfo(
                    name="ollama",
                    url=ollama_url,
                    status="online",
                    models=models
                ))
    except Exception:
        backends.append(BackendInfo(
            name="ollama",
            url=ollama_url,
            status="offline",
            models=[]
        ))

    return backends


@app.post("/session/start", response_model=SessionResponse)
async def start_session(request: SessionStartRequest):
    """Start a new monitoring session for a prompt"""
    session_id = str(uuid.uuid4())[:8]

    if request.backend not in extractors:
        raise HTTPException(status_code=400, detail=f"Unknown backend: {request.backend}")

    active_sessions[session_id] = {
        "prompt": request.prompt,
        "backend": request.backend,
        "model": request.model,
        "started_at": time.time(),
        "status": "running",
        "extract_attention": request.extract_attention,
        "extract_embeddings": request.extract_embeddings
    }

    # Start extraction in background
    asyncio.create_task(run_extraction(session_id, request))

    return SessionResponse(session_id=session_id, status="started")


async def run_extraction(session_id: str, request: SessionStartRequest):
    """Run the LLM and extract attention/embeddings"""
    try:
        extractor = extractors[request.backend]

        async for snapshot in extractor.stream_with_attention(
            prompt=request.prompt,
            model=request.model,
            extract_attention=request.extract_attention,
            extract_embeddings=request.extract_embeddings
        ):
            # Publish to Redis for WebSocket subscribers
            if redis_client:
                await redis_client.publish(
                    f"llm-monitor:{session_id}",
                    json.dumps(snapshot)
                )

            # Update session state
            active_sessions[session_id]["last_snapshot"] = snapshot

        active_sessions[session_id]["status"] = "completed"

    except Exception as e:
        active_sessions[session_id]["status"] = "error"
        active_sessions[session_id]["error"] = str(e)
        if redis_client:
            await redis_client.publish(
                f"llm-monitor:{session_id}",
                json.dumps({"error": str(e)})
            )


@app.get("/session/{session_id}/status")
async def get_session_status(session_id: str):
    """Get current status of a monitoring session"""
    if session_id not in active_sessions:
        raise HTTPException(status_code=404, detail="Session not found")

    session = active_sessions[session_id]
    return {
        "session_id": session_id,
        "status": session["status"],
        "backend": session["backend"],
        "model": session["model"],
        "elapsed": time.time() - session["started_at"]
    }


@app.get("/session/{session_id}/attention")
async def get_attention(session_id: str, layer: Optional[int] = None):
    """Get latest attention data for a session"""
    if session_id not in active_sessions:
        raise HTTPException(status_code=404, detail="Session not found")

    session = active_sessions[session_id]
    if "last_snapshot" not in session:
        return {"attention_heads": [], "tokens": []}

    snapshot = session["last_snapshot"]

    if layer is not None:
        # Filter to specific layer
        heads = [h for h in snapshot.get("attention_heads", []) if h["layer"] == layer]
        return {"attention_heads": heads, "tokens": snapshot.get("tokens", [])}

    return snapshot


@app.get("/session/{session_id}/embeddings")
async def get_embeddings(session_id: str, dimensions: int = 2):
    """Get projected embeddings for visualization"""
    if session_id not in active_sessions:
        raise HTTPException(status_code=404, detail="Session not found")

    session = active_sessions[session_id]
    if "last_snapshot" not in session:
        return {"embeddings": [], "tokens": []}

    snapshot = session["last_snapshot"]
    embeddings = snapshot.get("embeddings", [])
    tokens = snapshot.get("tokens", [])

    if embeddings and len(embeddings) > 0:
        projected = downsample_embeddings(embeddings, dimensions)
        return {"embeddings": projected.tolist(), "tokens": tokens}

    return {"embeddings": [], "tokens": tokens}


@app.get("/metrics/performance")
async def get_performance_metrics():
    """Get aggregated performance metrics across sessions"""
    total_tokens = 0
    total_time = 0

    for session in active_sessions.values():
        if "last_snapshot" in session:
            snapshot = session["last_snapshot"]
            total_tokens += snapshot.get("total_tokens", 0)
            total_time += snapshot.get("generation_time", 0)

    return PerformanceMetrics(
        tokens_per_second=total_tokens / max(total_time, 0.001),
        latency_ms=total_time * 1000 / max(len(active_sessions), 1),
        memory_mb=torch.cuda.memory_allocated() / 1024 / 1024 if torch.cuda.is_available() else 0,
        gpu_utilization=None  # Would need nvidia-smi
    )


# ----- WebSocket -----

@app.websocket("/ws/monitor/{session_id}")
async def websocket_monitor(websocket: WebSocket, session_id: str):
    """Real-time streaming of attention/embeddings via WebSocket"""
    await websocket.accept()

    if not redis_client:
        await websocket.send_json({"error": "Redis not available for streaming"})
        await websocket.close()
        return

    pubsub = redis_client.pubsub()
    await pubsub.subscribe(f"llm-monitor:{session_id}")

    try:
        async for message in pubsub.listen():
            if message["type"] == "message":
                data = json.loads(message["data"])
                await websocket.send_json(data)

                # Check if session completed
                if data.get("status") == "completed" or data.get("error"):
                    break
    except WebSocketDisconnect:
        pass
    finally:
        await pubsub.unsubscribe(f"llm-monitor:{session_id}")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8766)
