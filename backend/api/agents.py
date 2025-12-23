"""
Fleet Agents API

Endpoints for managing fleet agents running on GPU nodes.
Agents report metrics, execute commands, and maintain node health.
"""
from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel
from typing import Optional, List, Dict, Any
import os
import json
import uuid
import asyncio
from datetime import datetime
import redis.asyncio as redis

router = APIRouter()

REDIS_URL = os.getenv("REDIS_URL", "redis://comfyui-redis:6379")


class AgentRegistration(BaseModel):
    node_id: str
    cluster: str = "default"
    hostname: str
    ip_address: str
    gpu_count: int = 0
    gpu_names: List[str] = []
    agent_version: str = "1.0.0"
    capabilities: List[str] = []


class AgentCommand(BaseModel):
    type: str  # shell, docker_run, docker_stop, docker_logs, ping
    command: Optional[str] = None
    container: Optional[str] = None
    image: Optional[str] = None
    name: Optional[str] = None
    options: Optional[str] = None
    tail: Optional[int] = 100
    timeout: Optional[int] = 300


async def get_redis():
    """Get Redis connection."""
    return redis.from_url(REDIS_URL, decode_responses=True)


@router.post("/register")
async def register_agent(registration: AgentRegistration):
    """Register a new agent or update existing registration."""
    r = await get_redis()
    try:
        agent_data = {
            **registration.dict(),
            "registered_at": datetime.utcnow().isoformat(),
            "last_seen": datetime.utcnow().isoformat(),
            "status": "online",
        }

        # Store agent registration
        await r.hset(f"agent:{registration.node_id}", mapping={
            "data": json.dumps(agent_data)
        })

        # Add to active agents set
        await r.sadd("agents:registered", registration.node_id)

        # Store in cluster set
        await r.sadd(f"cluster:{registration.cluster}:agents", registration.node_id)

        return {
            "status": "registered",
            "node_id": registration.node_id,
            "message": f"Agent {registration.node_id} registered successfully"
        }
    finally:
        await r.close()


@router.get("")
async def list_agents(cluster: Optional[str] = None, status: Optional[str] = None):
    """List all registered agents with their current status."""
    r = await get_redis()
    try:
        # Get all registered agents
        agent_ids = await r.smembers("agents:registered")

        agents = []
        for node_id in agent_ids:
            # Get registration data
            agent_hash = await r.hgetall(f"agent:{node_id}")
            if not agent_hash:
                continue

            agent_data = json.loads(agent_hash.get("data", "{}"))

            # Get latest heartbeat
            heartbeat_raw = await r.get(f"agent:heartbeat:{node_id}")
            if heartbeat_raw:
                heartbeat = json.loads(heartbeat_raw)
                agent_data["status"] = "online"
                agent_data["last_heartbeat"] = heartbeat.get("timestamp")
                agent_data["system"] = heartbeat.get("system", {})
                agent_data["gpus"] = heartbeat.get("gpus", [])
                agent_data["containers"] = heartbeat.get("containers", [])
            else:
                agent_data["status"] = "offline"

            # Filter by cluster if specified
            if cluster and agent_data.get("cluster") != cluster:
                continue

            # Filter by status if specified
            if status and agent_data.get("status") != status:
                continue

            agents.append(agent_data)

        # Sort by cluster then node_id
        agents.sort(key=lambda x: (x.get("cluster", ""), x.get("node_id", "")))

        return {
            "agents": agents,
            "total": len(agents),
            "online": sum(1 for a in agents if a.get("status") == "online"),
            "offline": sum(1 for a in agents if a.get("status") == "offline"),
        }
    finally:
        await r.close()


@router.get("/{node_id}")
async def get_agent(node_id: str):
    """Get detailed information about a specific agent."""
    r = await get_redis()
    try:
        # Get registration data
        agent_hash = await r.hgetall(f"agent:{node_id}")
        if not agent_hash:
            raise HTTPException(status_code=404, detail=f"Agent {node_id} not found")

        agent_data = json.loads(agent_hash.get("data", "{}"))

        # Get latest heartbeat
        heartbeat_raw = await r.get(f"agent:heartbeat:{node_id}")
        if heartbeat_raw:
            heartbeat = json.loads(heartbeat_raw)
            agent_data["status"] = "online"
            agent_data["last_heartbeat"] = heartbeat.get("timestamp")
            agent_data["system"] = heartbeat.get("system", {})
            agent_data["gpus"] = heartbeat.get("gpus", [])
            agent_data["containers"] = heartbeat.get("containers", [])
        else:
            agent_data["status"] = "offline"

        return agent_data
    finally:
        await r.close()


@router.get("/{node_id}/metrics")
async def get_agent_metrics(node_id: str, duration: str = "1h"):
    """Get historical metrics for an agent."""
    r = await get_redis()
    try:
        # Parse duration
        duration_map = {"1m": 60, "5m": 300, "15m": 900, "1h": 3600, "6h": 21600, "24h": 86400}
        seconds = duration_map.get(duration, 3600)

        # Get metrics from stream
        stream_key = f"stream:metrics:{node_id}"
        entries = await r.xrevrange(stream_key, count=seconds)

        metrics = []
        for entry_id, data in entries:
            if "data" in data:
                metrics.append(json.loads(data["data"]))

        # Reverse to chronological order
        metrics.reverse()

        return {
            "node_id": node_id,
            "duration": duration,
            "count": len(metrics),
            "metrics": metrics
        }
    finally:
        await r.close()


@router.post("/{node_id}/command")
async def send_command(node_id: str, command: AgentCommand):
    """Send a command to an agent for execution."""
    r = await get_redis()
    try:
        # Check if agent is online
        heartbeat = await r.get(f"agent:heartbeat:{node_id}")
        if not heartbeat:
            raise HTTPException(status_code=503, detail=f"Agent {node_id} is offline")

        # Create command with ID
        cmd_id = str(uuid.uuid4())[:8]
        cmd_data = {
            "id": cmd_id,
            **command.dict()
        }

        # Publish command to agent
        await r.publish(f"commands:{node_id}", json.dumps(cmd_data))

        # Wait for result (with timeout)
        timeout = command.timeout or 300
        result_key = f"command:result:{cmd_id}"

        for _ in range(timeout * 10):  # Check every 100ms
            result = await r.get(result_key)
            if result:
                return json.loads(result)
            await asyncio.sleep(0.1)

        return {
            "command_id": cmd_id,
            "status": "pending",
            "message": "Command sent, result not yet available"
        }
    finally:
        await r.close()


@router.delete("/{node_id}")
async def unregister_agent(node_id: str):
    """Unregister an agent."""
    r = await get_redis()
    try:
        # Get agent data first
        agent_hash = await r.hgetall(f"agent:{node_id}")
        if agent_hash:
            agent_data = json.loads(agent_hash.get("data", "{}"))
            cluster = agent_data.get("cluster", "default")

            # Remove from cluster set
            await r.srem(f"cluster:{cluster}:agents", node_id)

        # Remove from registered set
        await r.srem("agents:registered", node_id)

        # Remove from active set
        await r.srem("agents:active", node_id)

        # Delete agent data
        await r.delete(f"agent:{node_id}")
        await r.delete(f"agent:heartbeat:{node_id}")

        return {"status": "unregistered", "node_id": node_id}
    finally:
        await r.close()


@router.get("/clusters/summary")
async def get_clusters_summary():
    """Get summary of all clusters and their agents."""
    r = await get_redis()
    try:
        # Get all registered agents
        agent_ids = await r.smembers("agents:registered")

        clusters = {}
        for node_id in agent_ids:
            agent_hash = await r.hgetall(f"agent:{node_id}")
            if not agent_hash:
                continue

            agent_data = json.loads(agent_hash.get("data", "{}"))
            cluster = agent_data.get("cluster", "default")

            if cluster not in clusters:
                clusters[cluster] = {
                    "name": cluster,
                    "agents": [],
                    "total_gpus": 0,
                    "online": 0,
                    "offline": 0,
                }

            # Check if online
            heartbeat = await r.get(f"agent:heartbeat:{node_id}")
            status = "online" if heartbeat else "offline"

            clusters[cluster]["agents"].append({
                "node_id": node_id,
                "status": status,
                "gpu_count": agent_data.get("gpu_count", 0),
            })
            clusters[cluster]["total_gpus"] += agent_data.get("gpu_count", 0)
            if status == "online":
                clusters[cluster]["online"] += 1
            else:
                clusters[cluster]["offline"] += 1

        return {
            "clusters": list(clusters.values()),
            "total_clusters": len(clusters),
        }
    finally:
        await r.close()


# WebSocket for real-time agent updates
connected_clients: Dict[str, List[WebSocket]] = {}


@router.websocket("/ws")
async def agents_websocket(websocket: WebSocket):
    """WebSocket for real-time agent metrics updates."""
    await websocket.accept()

    # Subscribe to all agent metrics
    r = await get_redis()
    pubsub = r.pubsub()

    try:
        # Subscribe to metrics pattern
        await pubsub.psubscribe("metrics:*")

        async for message in pubsub.listen():
            if message['type'] == 'pmessage':
                # Forward to WebSocket
                await websocket.send_json({
                    "type": "metrics",
                    "channel": message['channel'],
                    "data": json.loads(message['data'])
                })

    except WebSocketDisconnect:
        pass
    finally:
        await pubsub.unsubscribe()
        await r.close()


@router.websocket("/ws/{node_id}")
async def agent_websocket(websocket: WebSocket, node_id: str):
    """WebSocket for real-time updates from a specific agent."""
    await websocket.accept()

    r = await get_redis()
    pubsub = r.pubsub()

    try:
        await pubsub.subscribe(f"metrics:{node_id}")

        async for message in pubsub.listen():
            if message['type'] == 'message':
                await websocket.send_json({
                    "type": "metrics",
                    "node_id": node_id,
                    "data": json.loads(message['data'])
                })

    except WebSocketDisconnect:
        pass
    finally:
        await pubsub.unsubscribe()
        await r.close()
