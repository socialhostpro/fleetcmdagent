from fastapi import APIRouter, HTTPException, BackgroundTasks
from pydantic import BaseModel
from typing import List, Optional, Dict, Any
from services import docker_service
import asyncssh
import asyncio
import os

router = APIRouter()

# Default credentials
DEFAULT_USERNAME = os.getenv("JETSON_DEFAULT_USER", "jetson")
DEFAULT_PASSWORD = os.getenv("JETSON_DEFAULT_PASS", "jetson")

class ServiceCreate(BaseModel):
    name: str
    image: str
    replicas: int = 1
    mode: str = "replicated"  # 'replicated' or 'global'
    ports: Optional[List[Dict[str, int]]] = None  # [{"target_port": 80, "published_port": 8080}]
    env: Optional[List[str]] = None  # ["KEY=value"]
    mounts: Optional[List[Dict[str, str]]] = None  # [{"source": "/host/path", "target": "/container/path"}]
    constraints: Optional[List[str]] = None  # ["node.labels.gpu==true"]
    resources: Optional[Dict[str, Any]] = None  # {"cpu_limit": 1e9, "mem_limit": 1e9, "gpu": 1}
    networks: Optional[List[str]] = None

class ServiceUpdate(BaseModel):
    image: Optional[str] = None
    replicas: Optional[int] = None
    env: Optional[List[str]] = None
    force_update: bool = False

class ServiceScale(BaseModel):
    replicas: int

@router.get("/status")
def swarm_status():
    """Get Docker Swarm status and cluster info."""
    return docker_service.get_swarm_status()

@router.post("/init")
def init_swarm(advertise_addr: Optional[str] = None):
    """Initialize a new Docker Swarm cluster."""
    result = docker_service.init_swarm(advertise_addr)
    if "error" in result:
        raise HTTPException(status_code=500, detail=result["error"])
    return result

@router.post("/leave")
def leave_swarm(force: bool = False):
    """Leave the current Docker Swarm."""
    result = docker_service.leave_swarm(force)
    if "error" in result:
        raise HTTPException(status_code=500, detail=result["error"])
    return result

@router.get("/join-token")
def get_token(role: str = "worker"):
    """Get the join token for workers or managers."""
    token = docker_service.get_join_token(role)
    if not token:
        raise HTTPException(status_code=404, detail="Swarm not initialized or token not available")
    return {"token": token, "role": role}

@router.get("/nodes")
def list_nodes():
    """List all nodes in the Docker Swarm."""
    return docker_service.get_nodes()

@router.get("/services")
def list_services():
    """List all services in the Docker Swarm."""
    return docker_service.get_services()

@router.get("/services/{service_id}")
def get_service(service_id: str):
    """Get details of a specific service."""
    service = docker_service.get_service(service_id)
    if not service:
        raise HTTPException(status_code=404, detail="Service not found")
    return service

@router.post("/services")
def create_service(service: ServiceCreate):
    """Create a new Docker Swarm service."""
    result = docker_service.create_service(
        name=service.name,
        image=service.image,
        replicas=service.replicas,
        mode=service.mode,
        ports=service.ports,
        env=service.env,
        mounts=service.mounts,
        constraints=service.constraints,
        resources=service.resources,
        networks=service.networks,
    )
    if "error" in result:
        raise HTTPException(status_code=500, detail=result["error"])
    return result

@router.put("/services/{service_id}")
def update_service(service_id: str, update: ServiceUpdate):
    """Update an existing service."""
    result = docker_service.update_service(
        service_id=service_id,
        image=update.image,
        replicas=update.replicas,
        env=update.env,
        force_update=update.force_update,
    )
    if "error" in result:
        raise HTTPException(status_code=500, detail=result["error"])
    return result

@router.post("/services/{service_id}/scale")
def scale_service(service_id: str, scale: ServiceScale):
    """Scale a service to a specific number of replicas."""
    result = docker_service.scale_service(service_id, scale.replicas)
    if "error" in result:
        raise HTTPException(status_code=500, detail=result["error"])
    return result

@router.delete("/services/{service_id}")
def remove_service(service_id: str):
    """Remove a service from the swarm."""
    result = docker_service.remove_service(service_id)
    if "error" in result:
        raise HTTPException(status_code=500, detail=result["error"])
    return result

@router.get("/services/{service_id}/logs")
def get_service_logs(service_id: str, tail: int = 100):
    """Get logs from a service."""
    logs = docker_service.get_service_logs(service_id, tail)
    return {"logs": logs}


# === Remote Node Management ===

class RemoteJoinRequest(BaseModel):
    node_ip: str
    username: Optional[str] = None
    password: Optional[str] = None
    cluster: Optional[str] = None  # Label for cluster assignment

class NodeLabelRequest(BaseModel):
    labels: Dict[str, str]  # {"cluster": "vision", "gpu": "true"}

@router.post("/join-remote")
async def join_remote_node(req: RemoteJoinRequest):
    """SSH into a remote node and join it to the swarm."""
    # Get join token and manager address
    token_info = docker_service.get_join_token("worker")
    if not token_info:
        raise HTTPException(status_code=400, detail="Swarm not initialized")

    # Get swarm info for manager address
    swarm_status = docker_service.get_swarm_status()
    manager_addr = swarm_status.get("manager_addr", "192.168.1.214:2377")

    username = req.username or DEFAULT_USERNAME
    password = req.password or DEFAULT_PASSWORD

    try:
        async with asyncssh.connect(
            req.node_ip,
            username=username,
            password=password,
            known_hosts=None,
            connect_timeout=30
        ) as conn:
            sudo_prefix = f"echo '{password}' | sudo -S " if username != 'root' else ""

            # Check if already in swarm
            check_result = await conn.run(f"{sudo_prefix}docker info --format '{{{{.Swarm.LocalNodeState}}}}'", check=False)
            current_state = check_result.stdout.strip() if check_result.stdout else ""

            if current_state == "active":
                # Leave existing swarm first
                await conn.run(f"{sudo_prefix}docker swarm leave --force", check=False)
                await asyncio.sleep(2)

            # Join the swarm
            join_cmd = f"{sudo_prefix}docker swarm join --token {token_info} {manager_addr}"
            result = await conn.run(join_cmd, check=False)

            if result.exit_status != 0:
                return {
                    "status": "error",
                    "message": result.stderr or result.stdout or "Failed to join swarm",
                    "node_ip": req.node_ip
                }

            # Get the node ID
            node_id_result = await conn.run(f"{sudo_prefix}docker info --format '{{{{.Swarm.NodeID}}}}'", check=False)
            node_id = node_id_result.stdout.strip() if node_id_result.stdout else None

            # Apply cluster label if specified
            if req.cluster and node_id:
                # Labels must be applied from manager
                import docker
                client = docker.from_env()
                try:
                    node = client.nodes.get(node_id)
                    spec = node.attrs['Spec']
                    spec['Labels'] = spec.get('Labels', {})
                    spec['Labels']['cluster'] = req.cluster
                    node.update(spec)
                except Exception as e:
                    pass  # Label will be applied separately

            return {
                "status": "success",
                "message": f"Node {req.node_ip} joined swarm successfully",
                "node_id": node_id,
                "cluster": req.cluster
            }

    except asyncssh.PermissionDenied:
        raise HTTPException(status_code=401, detail="Permission denied - check credentials")
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="Connection timeout")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/nodes/{node_id}/labels")
def update_node_labels(node_id: str, req: NodeLabelRequest):
    """Update labels on a swarm node."""
    try:
        import docker
        client = docker.from_env()
        node = client.nodes.get(node_id)
        spec = node.attrs['Spec']
        spec['Labels'] = spec.get('Labels', {})
        spec['Labels'].update(req.labels)
        node.update(spec)
        return {
            "status": "success",
            "node_id": node_id,
            "labels": spec['Labels']
        }
    except docker.errors.NotFound:
        raise HTTPException(status_code=404, detail="Node not found")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/nodes/{node_id}/labels/{label_key}")
def remove_node_label(node_id: str, label_key: str):
    """Remove a label from a swarm node."""
    try:
        import docker
        client = docker.from_env()
        node = client.nodes.get(node_id)
        spec = node.attrs['Spec']
        if 'Labels' in spec and label_key in spec['Labels']:
            del spec['Labels'][label_key]
            node.update(spec)
        return {
            "status": "success",
            "node_id": node_id,
            "removed_label": label_key
        }
    except docker.errors.NotFound:
        raise HTTPException(status_code=404, detail="Node not found")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# === Standalone Container Management (SPARK Server) ===

@router.get("/containers")
def list_local_containers():
    """List all local Docker containers on SPARK server.

    These are standalone containers not managed by Swarm, including:
    - ComfyUI and workers
    - MinIO S3 storage
    - Redis
    - PostgreSQL
    - TTS/Joycaption services
    - Open WebUI
    - Ollama
    """
    containers = docker_service.get_local_containers()
    return {
        "containers": containers,
        "total": len(containers),
        "server": "SPARK (192.168.1.214)"
    }


@router.get("/containers/{container_id}")
def get_local_container(container_id: str):
    """Get details of a specific local container."""
    container = docker_service.get_local_container(container_id)
    if not container:
        raise HTTPException(status_code=404, detail="Container not found")
    return container


@router.get("/containers/{container_id}/logs")
def get_container_logs(container_id: str, tail: int = 100):
    """Get logs from a local container."""
    logs = docker_service.get_container_logs(container_id, tail)
    return {"logs": logs}


@router.post("/containers/{container_id}/restart")
def restart_container(container_id: str):
    """Restart a local container."""
    try:
        import docker
        client = docker.from_env()
        container = client.containers.get(container_id)
        container.restart()
        return {"status": "restarted", "container": container_id}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/containers/{container_id}/stop")
def stop_container(container_id: str):
    """Stop a local container."""
    try:
        import docker
        client = docker.from_env()
        container = client.containers.get(container_id)
        container.stop()
        return {"status": "stopped", "container": container_id}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/containers/{container_id}/start")
def start_container(container_id: str):
    """Start a stopped local container."""
    try:
        import docker
        client = docker.from_env()
        container = client.containers.get(container_id)
        container.start()
        return {"status": "started", "container": container_id}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
