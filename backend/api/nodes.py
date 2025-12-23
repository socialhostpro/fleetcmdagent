from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from typing import Dict, Any, Optional
import redis.asyncio as redis
import json
from datetime import datetime
import docker
from config import settings

router = APIRouter()


def get_swarm_cluster_info():
    """Get cluster labels from Docker Swarm nodes."""
    cluster_info = {}  # Maps IP address to cluster name and swarm_node_id
    try:
        client = docker.from_env()
        for node in client.nodes.list():
            attrs = node.attrs
            hostname = attrs.get('Description', {}).get('Hostname', '')
            ip_addr = attrs.get('Status', {}).get('Addr', '')
            labels = attrs.get('Spec', {}).get('Labels', {})
            cluster = labels.get('cluster', '')

            info = {
                'cluster': cluster,
                'swarm_node_id': node.id,
                'swarm_hostname': hostname,
                'swarm_status': attrs.get('Status', {}).get('State', 'unknown'),
                'swarm_availability': attrs.get('Spec', {}).get('Availability', 'unknown')
            }

            # Store by IP address (primary key for matching)
            if ip_addr:
                cluster_info[ip_addr] = info
            # Also store by hostname for fallback
            if hostname:
                cluster_info[hostname] = info
    except Exception as e:
        print(f"Error getting swarm cluster info: {e}")
    return cluster_info

# Redis connection
r = redis.from_url(settings.REDIS_URL, decode_responses=True)


class NodeHeartbeat(BaseModel):
    node_id: str
    timestamp: str
    ip: Optional[str] = None
    cpu_percent: Optional[float] = None
    cpu: Optional[float] = None  # Legacy field
    memory: Dict[str, Any]
    disk: Dict[str, Any]
    gpu: Dict[str, Any]
    power: Optional[Dict[str, Any]] = None
    activity: Optional[Dict[str, Any]] = None
    docker: Optional[Dict[str, Any]] = None
    jetpack: Optional[Dict[str, Any]] = None  # JetPack/L4T version info
    errors: Optional[list] = None  # Recent system errors
    error_count: Optional[int] = None  # Total error count
    temperatures: Optional[Dict[str, Any]] = None  # System temperatures
    throttle: Optional[Dict[str, Any]] = None  # Thermal throttling status
    swarm: Optional[Dict[str, Any]] = None  # Docker Swarm status
    status: Optional[str] = None  # Online status


@router.post("/{node_id}/heartbeat")
async def report_heartbeat(node_id: str, heartbeat: NodeHeartbeat, request: Request):
    # Get the client IP address (fallback if not in heartbeat)
    client_ip = heartbeat.ip or (request.client.host if request.client else None)

    # Build heartbeat data
    heartbeat_data = heartbeat.model_dump()
    heartbeat_data['ip'] = client_ip

    # Normalize cpu field
    if heartbeat_data.get('cpu_percent') is not None:
        heartbeat_data['cpu'] = heartbeat_data['cpu_percent']

    # Store heartbeat in Redis with 120s expiry (allows for reboots)
    await r.set(f"node:{node_id}:heartbeat", json.dumps(heartbeat_data), ex=120)

    # Also add to a set of known nodes
    await r.sadd("nodes:active", node_id)

    # Store power history (last 100 readings)
    if heartbeat_data.get('power'):
        power_entry = {
            'timestamp': heartbeat_data['timestamp'],
            'total_w': heartbeat_data['power'].get('total_w', 0),
            'gpu_w': heartbeat_data['power'].get('gpu_w', 0),
            'cpu_w': heartbeat_data['power'].get('cpu_w', 0),
        }
        await r.lpush(f"node:{node_id}:power_history", json.dumps(power_entry))
        await r.ltrim(f"node:{node_id}:power_history", 0, 99)  # Keep last 100

    return {"status": "received"}

@router.get("/")
async def list_nodes():
    nodes = []
    node_ids = await r.smembers("nodes:active")

    # Get cluster info from Docker Swarm
    swarm_info = get_swarm_cluster_info()

    for nid in node_ids:
        data = await r.get(f"node:{nid}:heartbeat")
        if data:
            node = json.loads(data)

            # Enrich with cluster info from Swarm
            # Try matching by IP first (most reliable), then by node_id
            node_ip = node.get('ip', '')
            node_hostname = node.get('node_id', '')

            swarm_match = None
            if node_ip and node_ip in swarm_info:
                swarm_match = swarm_info[node_ip]
            elif node_hostname in swarm_info:
                swarm_match = swarm_info[node_hostname]

            if swarm_match:
                node['cluster'] = swarm_match.get('cluster', '')
                node['swarm_node_id'] = swarm_match.get('swarm_node_id', '')
                node['swarm_status'] = swarm_match.get('swarm_status', '')
                node['swarm_availability'] = swarm_match.get('swarm_availability', '')
            else:
                node['cluster'] = ''
                node['swarm_node_id'] = ''

            nodes.append(node)
        else:
            # Clean up expired node from set
            await r.srem("nodes:active", nid)
    return nodes


@router.get("/containers")
async def get_all_node_containers():
    """Get running containers from all nodes."""
    import asyncio
    import asyncssh

    nodes_data = []
    node_ids = await r.smembers("nodes:active")
    swarm_info = get_swarm_cluster_info()

    async def get_node_containers(node_id: str):
        data = await r.get(f"node:{node_id}:heartbeat")
        if not data:
            return None

        node = json.loads(data)
        node_ip = node.get('ip', '')

        cluster = ''
        if node_ip in swarm_info:
            cluster = swarm_info[node_ip].get('cluster', '')
        elif node_id in swarm_info:
            cluster = swarm_info[node_id].get('cluster', '')

        containers = []
        try:
            async with asyncssh.connect(
                node_ip, port=22,
                username='nvidia', password='nvidia',
                known_hosts=None, connect_timeout=5
            ) as conn:
                # Try without sudo first, then with password
                result = await conn.run(
                    'docker ps --format "{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}" 2>/dev/null || echo nvidia | sudo -S docker ps --format "{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}" 2>/dev/null',
                    timeout=10
                )
                if result.exit_status == 0 and result.stdout.strip():
                    for line in result.stdout.strip().split('\n'):
                        if '|' not in line:
                            continue  # Skip sudo password output
                        parts = line.split('|')
                        if len(parts) >= 3:
                            containers.append({
                                'name': parts[0],
                                'image': parts[1] if len(parts) > 1 else '',
                                'status': parts[2] if len(parts) > 2 else '',
                                'ports': parts[3] if len(parts) > 3 else ''
                            })
        except Exception as e:
            print(f"Error fetching containers from {node_id}: {e}")

        return {
            'node_id': node_id,
            'ip': node_ip,
            'cluster': cluster,
            'cpu': node.get('cpu', 0),
            'gpu': node.get('gpu', {}),
            'memory': node.get('memory', {}),
            'containers': containers
        }

    tasks = [get_node_containers(nid) for nid in node_ids]
    results = await asyncio.gather(*tasks, return_exceptions=True)

    for result in results:
        if result and not isinstance(result, Exception):
            nodes_data.append(result)

    return {'nodes': nodes_data}


@router.get("/{node_id}/power-history")
async def get_power_history(node_id: str, limit: int = 100):
    """Get power consumption history for a node."""
    history = await r.lrange(f"node:{node_id}:power_history", 0, limit - 1)
    return [json.loads(h) for h in history]


@router.get("/{node_id}")
async def get_node(node_id: str):
    """Get current status for a specific node."""
    data = await r.get(f"node:{node_id}:heartbeat")
    if not data:
        raise HTTPException(status_code=404, detail="Node not found or offline")
    return json.loads(data)


class NodeRegistration(BaseModel):
    """Registration payload from Fleet Agent"""
    node_id: str
    hostname: str
    ip: str
    platform: str = "linux"
    cluster: Optional[str] = "default"
    gpu_name: Optional[str] = None
    gpu_memory_mb: Optional[int] = 0
    gpu_count: Optional[int] = 0
    agent_port: Optional[int] = 9100
    agent_version: Optional[str] = "1.0.0"
    capabilities: Optional[list] = []


class AgentHeartbeat(BaseModel):
    """Heartbeat from Fleet Agent (Windows/standalone nodes)"""
    node_id: str
    cluster: Optional[str] = "windows"
    platform: Optional[str] = "windows"
    hostname: Optional[str] = None
    ip: Optional[str] = None
    agent_port: Optional[int] = 9100
    timestamp: Optional[str] = None
    cpu: Optional[float] = 0
    memory: Optional[float] = 0
    disk: Optional[float] = 0
    gpu: Optional[float] = 0
    gpu_memory: Optional[int] = 0
    temperature: Optional[int] = 0
    gpu_info: Optional[Dict[str, Any]] = None
    containers_running: Optional[int] = 0
    containers_total: Optional[int] = 0
    status: Optional[str] = "online"


@router.post("/register")
async def register_node(registration: NodeRegistration, request: Request):
    """Register a new Fleet Agent node."""
    client_ip = registration.ip or (request.client.host if request.client else None)

    # Store node registration info
    reg_data = registration.model_dump()
    reg_data['ip'] = client_ip
    reg_data['registered_at'] = datetime.utcnow().isoformat()

    await r.set(f"node:{registration.node_id}:registration", json.dumps(reg_data))
    await r.sadd("nodes:active", registration.node_id)
    await r.sadd(f"cluster:{registration.cluster}:nodes", registration.node_id)

    print(f"[Fleet Agent] Registered: {registration.node_id} ({registration.gpu_name}) from {client_ip}")

    return {"status": "registered", "node_id": registration.node_id}


@router.post("/heartbeat")
async def agent_heartbeat(heartbeat: AgentHeartbeat, request: Request):
    """Receive heartbeat from Fleet Agent (Windows/standalone nodes)."""
    client_ip = heartbeat.ip or (request.client.host if request.client else None)

    # Convert agent heartbeat to standard node format
    heartbeat_data = {
        "node_id": heartbeat.node_id,
        "ip": client_ip,
        "timestamp": heartbeat.timestamp or datetime.utcnow().isoformat(),
        "cpu": heartbeat.cpu,
        "cpu_percent": heartbeat.cpu,
        "memory": {
            "percent": heartbeat.memory,
            "used_mb": 0,
            "total_mb": 0
        },
        "disk": {
            "percent": heartbeat.disk,
            "used_gb": 0,
            "total_gb": 0
        },
        "gpu": {
            "utilization": heartbeat.gpu,
            "memory_used_mb": heartbeat.gpu_memory,
            "memory_total_mb": heartbeat.gpu_info.get("gpus", [{}])[0].get("memory_total", 0) if heartbeat.gpu_info else 0,
            "name": heartbeat.gpu_info.get("gpus", [{}])[0].get("name", "Unknown") if heartbeat.gpu_info else "Unknown",
            "temperature": heartbeat.temperature
        },
        "docker": {
            "containers_running": heartbeat.containers_running,
            "containers_total": heartbeat.containers_total
        },
        "platform": heartbeat.platform,
        "cluster": heartbeat.cluster,
        "agent_port": heartbeat.agent_port,
        "status": heartbeat.status or "online"
    }

    # Store heartbeat in Redis with 120s expiry
    await r.set(f"node:{heartbeat.node_id}:heartbeat", json.dumps(heartbeat_data), ex=120)
    await r.sadd("nodes:active", heartbeat.node_id)

    return {"status": "received"}


@router.get("/fleet/summary")
async def get_fleet_summary():
    """Get summary of all fleet nodes including total power consumption."""
    nodes = []
    total_power = 0
    total_gpu_power = 0
    active_count = 0
    computing_count = 0
    clusters = {}  # cluster_name -> node count

    # Get cluster info from Docker Swarm
    swarm_info = get_swarm_cluster_info()

    node_ids = await r.smembers("nodes:active")
    for nid in node_ids:
        data = await r.get(f"node:{nid}:heartbeat")
        if data:
            node = json.loads(data)

            # Enrich with cluster info - match by IP first, then hostname
            node_ip = node.get('ip', '')
            node_hostname = node.get('node_id', '')

            swarm_match = None
            if node_ip and node_ip in swarm_info:
                swarm_match = swarm_info[node_ip]
            elif node_hostname in swarm_info:
                swarm_match = swarm_info[node_hostname]

            if swarm_match:
                cluster = swarm_match.get('cluster', '')
                node['cluster'] = cluster
                node['swarm_node_id'] = swarm_match.get('swarm_node_id', '')
                if cluster:
                    clusters[cluster] = clusters.get(cluster, 0) + 1
            else:
                node['cluster'] = ''

            nodes.append(node)
            active_count += 1

            # Sum power
            if node.get('power'):
                total_power += node['power'].get('total_w', 0)
                total_gpu_power += node['power'].get('gpu_w', 0)

            # Count computing nodes
            activity = node.get('activity') or {}
            if activity.get('status') == 'computing':
                computing_count += 1

    return {
        'active_nodes': active_count,
        'computing_nodes': computing_count,
        'total_power_w': round(total_power, 1),
        'total_gpu_power_w': round(total_gpu_power, 1),
        'clusters': clusters,
        'nodes': nodes
    }
