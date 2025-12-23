import asyncio
import asyncssh
from fastapi import APIRouter, HTTPException, BackgroundTasks
from pydantic import BaseModel
from typing import List, Optional, Dict, Any
import redis.asyncio as redis
import json
import uuid
from config import settings

router = APIRouter()
r = redis.from_url(settings.REDIS_URL, decode_responses=True)

class ClusterCreate(BaseModel):
    name: str
    cluster_type: str  # 'swarm', 'logical', 'kubernetes'
    node_ids: List[str]
    manager_node_id: Optional[str] = None

class ClusterUpdate(BaseModel):
    name: Optional[str] = None
    node_ids: Optional[List[str]] = None

class Cluster(BaseModel):
    id: str
    name: str
    cluster_type: str
    node_ids: List[str]
    manager_node_id: Optional[str] = None
    status: str  # 'creating', 'active', 'error', 'stopped'
    swarm_join_token: Optional[str] = None
    created_at: str

@router.post("/")
async def create_cluster(cluster: ClusterCreate, background_tasks: BackgroundTasks):
    """Create a new cluster from selected nodes."""
    cluster_id = str(uuid.uuid4())

    # Get manager node (first node if not specified)
    manager_id = cluster.manager_node_id or (cluster.node_ids[0] if cluster.node_ids else None)

    from datetime import datetime
    cluster_data = {
        "id": cluster_id,
        "name": cluster.name,
        "cluster_type": cluster.cluster_type,
        "node_ids": cluster.node_ids,
        "manager_node_id": manager_id,
        "status": "creating",
        "swarm_join_token": None,
        "created_at": datetime.utcnow().isoformat()
    }

    # Store cluster in Redis
    await r.hset("clusters", cluster_id, json.dumps(cluster_data))

    # If it's a Docker Swarm cluster, initialize it
    if cluster.cluster_type == "swarm":
        background_tasks.add_task(initialize_swarm_cluster, cluster_id, cluster_data)
    else:
        # Logical clusters are immediately active
        cluster_data["status"] = "active"
        await r.hset("clusters", cluster_id, json.dumps(cluster_data))

    return {"cluster_id": cluster_id, "status": "creating" if cluster.cluster_type == "swarm" else "active"}

async def get_node_connection_info(node_id: str) -> Optional[Dict[str, Any]]:
    """Get connection info for a node (IP, credentials)."""
    # Try to get node heartbeat data which may contain IP
    heartbeat = await r.get(f"node:{node_id}:heartbeat")
    if heartbeat:
        data = json.loads(heartbeat)
        return data
    return None

async def get_node_credential(node_id: str) -> Optional[Dict[str, str]]:
    """Get SSH credentials for a node."""
    # First check if there's a node-specific credential
    cred_id = await r.hget("node:credentials", node_id)
    if cred_id:
        cred_json = await r.hget("vault:credentials", cred_id)
        if cred_json:
            return json.loads(cred_json)

    # Fall back to default credential
    cred_json = await r.hget("vault:credentials", "default")
    if cred_json:
        return json.loads(cred_json)

    # Fall back to first available credential
    all_creds = await r.hgetall("vault:credentials")
    if all_creds:
        first_cred = list(all_creds.values())[0]
        return json.loads(first_cred)

    return None

async def initialize_swarm_cluster(cluster_id: str, cluster_data: Dict):
    """Initialize a Docker Swarm cluster across nodes."""
    try:
        manager_id = cluster_data["manager_node_id"]
        node_ids = cluster_data["node_ids"]

        # Get manager connection info
        manager_info = await get_node_connection_info(manager_id)
        if not manager_info or 'ip' not in manager_info:
            cluster_data["status"] = "error"
            cluster_data["error"] = f"Cannot get connection info for manager node {manager_id}"
            await r.hset("clusters", cluster_id, json.dumps(cluster_data))
            return

        manager_ip = manager_info.get('ip', manager_id)

        # Get credentials
        cred = await get_node_credential(manager_id)
        if not cred:
            cluster_data["status"] = "error"
            cluster_data["error"] = "No SSH credentials available"
            await r.hset("clusters", cluster_id, json.dumps(cluster_data))
            return

        # Initialize swarm on manager
        async with asyncssh.connect(
            manager_ip,
            username=cred['username'],
            password=cred['password'],
            known_hosts=None,
            connect_timeout=30
        ) as conn:
            # Use sudo for docker commands (user may not be in docker group)
            sudo_prefix = f"echo '{cred['password']}' | sudo -S "

            # Check if already in a swarm
            check_result = await conn.run(f"{sudo_prefix}docker info --format '{{{{.Swarm.LocalNodeState}}}}'")
            swarm_state = check_result.stdout.strip()

            if swarm_state == "active":
                # Already in swarm, get join token
                token_result = await conn.run(f"{sudo_prefix}docker swarm join-token worker -q")
                join_token = token_result.stdout.strip()
            else:
                # Initialize new swarm
                init_result = await conn.run(f"{sudo_prefix}docker swarm init --advertise-addr {manager_ip}")
                if init_result.exit_status != 0:
                    raise Exception(f"Failed to init swarm: {init_result.stderr}")

                # Get join token
                token_result = await conn.run(f"{sudo_prefix}docker swarm join-token worker -q")
                join_token = token_result.stdout.strip()

        cluster_data["swarm_join_token"] = join_token
        cluster_data["swarm_manager_ip"] = manager_ip

        # Join worker nodes
        worker_nodes = [n for n in node_ids if n != manager_id]
        join_errors = []

        for worker_id in worker_nodes:
            try:
                worker_info = await get_node_connection_info(worker_id)
                worker_ip = worker_info.get('ip', worker_id) if worker_info else worker_id
                worker_cred = await get_node_credential(worker_id) or cred

                async with asyncssh.connect(
                    worker_ip,
                    username=worker_cred['username'],
                    password=worker_cred['password'],
                    known_hosts=None,
                    connect_timeout=30
                ) as conn:
                    # Use sudo for docker commands
                    sudo_prefix = f"echo '{worker_cred['password']}' | sudo -S "

                    # Check if already in swarm
                    check_result = await conn.run(f"{sudo_prefix}docker info --format '{{{{.Swarm.LocalNodeState}}}}'")
                    if check_result.stdout.strip() == "active":
                        # Leave current swarm first
                        await conn.run(f"{sudo_prefix}docker swarm leave --force")

                    # Join the new swarm
                    join_cmd = f"{sudo_prefix}docker swarm join --token {join_token} {manager_ip}:2377"
                    join_result = await conn.run(join_cmd)

                    if join_result.exit_status != 0:
                        join_errors.append(f"{worker_id}: {join_result.stderr}")
            except Exception as e:
                join_errors.append(f"{worker_id}: {str(e)}")

        if join_errors:
            cluster_data["status"] = "partial"
            cluster_data["join_errors"] = join_errors
        else:
            cluster_data["status"] = "active"

        await r.hset("clusters", cluster_id, json.dumps(cluster_data))

    except Exception as e:
        cluster_data["status"] = "error"
        cluster_data["error"] = str(e)
        await r.hset("clusters", cluster_id, json.dumps(cluster_data))

@router.get("/")
async def list_clusters():
    """List all clusters."""
    clusters = await r.hgetall("clusters")
    result = []
    for cluster_json in clusters.values():
        cluster = json.loads(cluster_json)
        result.append(cluster)
    return result

@router.get("/{cluster_id}")
async def get_cluster(cluster_id: str):
    """Get cluster details."""
    cluster_json = await r.hget("clusters", cluster_id)
    if not cluster_json:
        raise HTTPException(status_code=404, detail="Cluster not found")
    return json.loads(cluster_json)

@router.get("/{cluster_id}/status")
async def get_cluster_status(cluster_id: str):
    """Get detailed cluster status including node health."""
    cluster_json = await r.hget("clusters", cluster_id)
    if not cluster_json:
        raise HTTPException(status_code=404, detail="Cluster not found")

    cluster = json.loads(cluster_json)

    # Get status of each node
    node_statuses = []
    for node_id in cluster["node_ids"]:
        heartbeat = await r.get(f"node:{node_id}:heartbeat")
        if heartbeat:
            data = json.loads(heartbeat)
            node_statuses.append({
                "node_id": node_id,
                "status": "online",
                "cpu": data.get("cpu"),
                "memory": data.get("memory"),
                "gpu": data.get("gpu"),
                "is_manager": node_id == cluster.get("manager_node_id")
            })
        else:
            node_statuses.append({
                "node_id": node_id,
                "status": "offline",
                "is_manager": node_id == cluster.get("manager_node_id")
            })

    return {
        "cluster": cluster,
        "nodes": node_statuses,
        "online_count": sum(1 for n in node_statuses if n["status"] == "online"),
        "total_count": len(node_statuses)
    }

@router.put("/{cluster_id}")
async def update_cluster(cluster_id: str, update: ClusterUpdate):
    """Update cluster configuration."""
    cluster_json = await r.hget("clusters", cluster_id)
    if not cluster_json:
        raise HTTPException(status_code=404, detail="Cluster not found")

    cluster = json.loads(cluster_json)

    if update.name:
        cluster["name"] = update.name
    if update.node_ids is not None:
        cluster["node_ids"] = update.node_ids

    await r.hset("clusters", cluster_id, json.dumps(cluster))
    return cluster

@router.delete("/{cluster_id}")
async def delete_cluster(cluster_id: str, cleanup_swarm: bool = False):
    """Delete a cluster. Optionally cleanup Docker Swarm."""
    cluster_json = await r.hget("clusters", cluster_id)
    if not cluster_json:
        raise HTTPException(status_code=404, detail="Cluster not found")

    cluster = json.loads(cluster_json)

    if cleanup_swarm and cluster["cluster_type"] == "swarm":
        # Leave swarm on all nodes
        for node_id in cluster["node_ids"]:
            try:
                node_info = await get_node_connection_info(node_id)
                node_ip = node_info.get('ip', node_id) if node_info else node_id
                cred = await get_node_credential(node_id)

                if cred:
                    async with asyncssh.connect(
                        node_ip,
                        username=cred['username'],
                        password=cred['password'],
                        known_hosts=None,
                        connect_timeout=30
                    ) as conn:
                        sudo_prefix = f"echo '{cred['password']}' | sudo -S "
                        await conn.run(f"{sudo_prefix}docker swarm leave --force")
            except Exception as e:
                # Log error but continue
                print(f"Error leaving swarm on {node_id}: {e}")

    await r.hdel("clusters", cluster_id)
    return {"status": "deleted"}

@router.post("/{cluster_id}/nodes/{node_id}")
async def add_node_to_cluster(cluster_id: str, node_id: str, background_tasks: BackgroundTasks):
    """Add a node to an existing cluster."""
    cluster_json = await r.hget("clusters", cluster_id)
    if not cluster_json:
        raise HTTPException(status_code=404, detail="Cluster not found")

    cluster = json.loads(cluster_json)

    if node_id in cluster["node_ids"]:
        raise HTTPException(status_code=400, detail="Node already in cluster")

    cluster["node_ids"].append(node_id)

    if cluster["cluster_type"] == "swarm" and cluster.get("swarm_join_token"):
        # Join the node to swarm
        background_tasks.add_task(
            join_node_to_swarm,
            cluster_id,
            node_id,
            cluster["swarm_manager_ip"],
            cluster["swarm_join_token"]
        )

    await r.hset("clusters", cluster_id, json.dumps(cluster))
    return {"status": "adding", "node_id": node_id}

async def join_node_to_swarm(cluster_id: str, node_id: str, manager_ip: str, join_token: str):
    """Join a single node to an existing swarm."""
    try:
        node_info = await get_node_connection_info(node_id)
        node_ip = node_info.get('ip', node_id) if node_info else node_id
        cred = await get_node_credential(node_id)

        if not cred:
            return

        async with asyncssh.connect(
            node_ip,
            username=cred['username'],
            password=cred['password'],
            known_hosts=None,
            connect_timeout=30
        ) as conn:
            # Use sudo for docker commands
            sudo_prefix = f"echo '{cred['password']}' | sudo -S "

            # Leave any existing swarm
            await conn.run(f"{sudo_prefix}docker swarm leave --force")

            # Join new swarm
            join_cmd = f"{sudo_prefix}docker swarm join --token {join_token} {manager_ip}:2377"
            await conn.run(join_cmd)
    except Exception as e:
        print(f"Error joining {node_id} to swarm: {e}")

@router.delete("/{cluster_id}/nodes/{node_id}")
async def remove_node_from_cluster(cluster_id: str, node_id: str):
    """Remove a node from a cluster."""
    cluster_json = await r.hget("clusters", cluster_id)
    if not cluster_json:
        raise HTTPException(status_code=404, detail="Cluster not found")

    cluster = json.loads(cluster_json)

    if node_id not in cluster["node_ids"]:
        raise HTTPException(status_code=400, detail="Node not in cluster")

    if node_id == cluster.get("manager_node_id"):
        raise HTTPException(status_code=400, detail="Cannot remove manager node")

    cluster["node_ids"].remove(node_id)

    # Leave swarm if it's a swarm cluster
    if cluster["cluster_type"] == "swarm":
        try:
            node_info = await get_node_connection_info(node_id)
            node_ip = node_info.get('ip', node_id) if node_info else node_id
            cred = await get_node_credential(node_id)

            if cred:
                async with asyncssh.connect(
                    node_ip,
                    username=cred['username'],
                    password=cred['password'],
                    known_hosts=None,
                    connect_timeout=30
                ) as conn:
                    sudo_prefix = f"echo '{cred['password']}' | sudo -S "
                    await conn.run(f"{sudo_prefix}docker swarm leave --force")
        except Exception as e:
            print(f"Error removing {node_id} from swarm: {e}")

    await r.hset("clusters", cluster_id, json.dumps(cluster))
    return {"status": "removed", "node_id": node_id}
