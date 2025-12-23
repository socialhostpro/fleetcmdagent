from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from typing import List, Dict, Set
import redis.asyncio as redis
import json
import asyncio
from config import settings

router = APIRouter()

# Connection manager for WebSocket clients
class ConnectionManager:
    def __init__(self):
        self.active_connections: Set[WebSocket] = set()

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.add(websocket)

    def disconnect(self, websocket: WebSocket):
        self.active_connections.discard(websocket)

    async def broadcast(self, message: dict):
        disconnected = set()
        for connection in self.active_connections:
            try:
                await connection.send_json(message)
            except Exception:
                disconnected.add(connection)
        # Clean up disconnected clients
        self.active_connections -= disconnected

manager = ConnectionManager()

# Redis connection
r = redis.from_url(settings.REDIS_URL, decode_responses=True)

async def get_all_nodes_data() -> List[Dict]:
    """Fetch all active nodes from Redis"""
    nodes = []
    node_ids = await r.smembers("nodes:active")
    for nid in node_ids:
        data = await r.get(f"node:{nid}:heartbeat")
        if data:
            nodes.append(json.loads(data))
        else:
            await r.srem("nodes:active", nid)
    return nodes

@router.websocket("/ws/metrics")
async def websocket_metrics(websocket: WebSocket):
    """WebSocket endpoint for real-time metrics streaming"""
    await manager.connect(websocket)
    try:
        # Send initial data immediately
        nodes = await get_all_nodes_data()
        await websocket.send_json({
            "type": "nodes_update",
            "data": nodes,
            "timestamp": asyncio.get_event_loop().time()
        })

        # Keep connection alive and stream updates
        while True:
            try:
                # Check for client messages (ping/pong, commands)
                try:
                    data = await asyncio.wait_for(
                        websocket.receive_text(),
                        timeout=2.0
                    )
                    # Handle client commands if needed
                    if data == "ping":
                        await websocket.send_json({"type": "pong"})
                except asyncio.TimeoutError:
                    pass

                # Fetch and broadcast updated metrics
                nodes = await get_all_nodes_data()
                await websocket.send_json({
                    "type": "nodes_update",
                    "data": nodes,
                    "timestamp": asyncio.get_event_loop().time()
                })

            except WebSocketDisconnect:
                break

    except Exception as e:
        print(f"WebSocket error: {e}")
    finally:
        manager.disconnect(websocket)

@router.websocket("/ws/logs/{node_id}")
async def websocket_logs(websocket: WebSocket, node_id: str):
    """WebSocket endpoint for streaming logs from a specific node"""
    await manager.connect(websocket)
    try:
        # Subscribe to Redis channel for this node's logs
        pubsub = r.pubsub()
        await pubsub.subscribe(f"logs:{node_id}")

        await websocket.send_json({
            "type": "connected",
            "node_id": node_id
        })

        while True:
            try:
                # Check for messages on the Redis channel
                message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
                if message and message['type'] == 'message':
                    await websocket.send_json({
                        "type": "log",
                        "data": message['data']
                    })

                # Also check for client messages
                try:
                    data = await asyncio.wait_for(websocket.receive_text(), timeout=0.1)
                    if data == "ping":
                        await websocket.send_json({"type": "pong"})
                except asyncio.TimeoutError:
                    pass

            except WebSocketDisconnect:
                break

    except Exception as e:
        print(f"WebSocket logs error: {e}")
    finally:
        await pubsub.unsubscribe(f"logs:{node_id}")
        manager.disconnect(websocket)


# Fleet Doctor connection manager (separate from metrics)
class DoctorConnectionManager:
    def __init__(self):
        self.active_connections: Set[WebSocket] = set()

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.add(websocket)

    def disconnect(self, websocket: WebSocket):
        self.active_connections.discard(websocket)

    async def broadcast(self, message: dict):
        disconnected = set()
        for connection in self.active_connections:
            try:
                await connection.send_json(message)
            except Exception:
                disconnected.add(connection)
        self.active_connections -= disconnected


doctor_manager = DoctorConnectionManager()


@router.websocket("/ws/doctor")
async def websocket_doctor(websocket: WebSocket):
    """WebSocket endpoint for Fleet Doctor real-time events.

    Streams events:
    - problem_detected: New problem found
    - diagnosis_complete: AI diagnosis finished
    - action_completed: Remediation succeeded
    - action_failed: Remediation failed
    - escalation: Problem requires human intervention
    - error: Doctor encountered an error
    """
    await doctor_manager.connect(websocket)
    try:
        # Subscribe to Fleet Doctor events channel
        pubsub = r.pubsub()
        await pubsub.subscribe("fleet:doctor:events")

        await websocket.send_json({
            "type": "connected",
            "message": "Connected to Fleet Doctor event stream"
        })

        while True:
            try:
                # Check for messages on the Redis channel
                message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
                if message and message['type'] == 'message':
                    try:
                        event_data = json.loads(message['data'])
                        await websocket.send_json(event_data)
                    except json.JSONDecodeError:
                        await websocket.send_json({
                            "type": "raw_event",
                            "data": message['data']
                        })

                # Also check for client messages (ping/pong)
                try:
                    data = await asyncio.wait_for(websocket.receive_text(), timeout=0.1)
                    if data == "ping":
                        await websocket.send_json({"type": "pong"})
                    elif data == "status":
                        # Send current doctor status on request
                        try:
                            from services.fleet_doctor import fleet_doctor
                            if fleet_doctor:
                                status = await fleet_doctor.get_status()
                                await websocket.send_json({
                                    "type": "status",
                                    "data": status
                                })
                        except Exception as e:
                            await websocket.send_json({
                                "type": "error",
                                "message": str(e)
                            })
                except asyncio.TimeoutError:
                    pass

            except WebSocketDisconnect:
                break

    except Exception as e:
        print(f"WebSocket doctor error: {e}")
    finally:
        await pubsub.unsubscribe("fleet:doctor:events")
        doctor_manager.disconnect(websocket)
