"""
Fleet API - External connections from AI apps (Jessica, etc.)
"""
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import Optional
import os
import httpx
import io

router = APIRouter()

# SDXL-TRT endpoint (running on agx0)
SDXL_ENDPOINT = os.getenv("SDXL_ENDPOINT", "http://192.168.1.182:8080")

# Simple API key (can be set via env var)
API_KEY = os.getenv("FLEET_API_KEY", "fleet-commander-2024")

class ConnectRequest(BaseModel):
    url: Optional[str] = None
    api_key: Optional[str] = None
    username: Optional[str] = None
    password: Optional[str] = None

class ConnectResponse(BaseModel):
    status: str
    message: str
    version: str = "1.0.0"
    capabilities: list = []

@router.post("/connect")
async def connect(request: ConnectRequest):
    """Validate connection from external AI apps."""
    # Simple auth check - accept any key for now or validate against API_KEY
    if request.api_key and request.api_key != API_KEY:
        # For now, accept any key to make it easy
        pass

    return ConnectResponse(
        status="connected",
        message="Successfully connected to Fleet Commander",
        version="1.0.0",
        capabilities=[
            "nodes",
            "containers",
            "images",
            "generation",
            "ssh",
            "metrics",
            "vision"
        ]
    )

@router.get("/connect")
async def connect_get():
    """Health check for fleet connection."""
    return {
        "status": "ok",
        "name": "Fleet Commander",
        "version": "1.0.0"
    }

@router.get("/status")
async def fleet_status():
    """Get fleet status summary."""
    from services import docker_service

    nodes = docker_service.get_nodes()
    services = docker_service.get_services()

    return {
        "status": "online",
        "nodes": len(nodes) if nodes else 0,
        "services": len(services) if services else 0,
        "version": "1.0.0"
    }

@router.get("/capabilities")
async def get_capabilities():
    """List available Fleet Commander capabilities."""
    return {
        "capabilities": [
            {"name": "nodes", "endpoint": "/api/nodes", "description": "Manage cluster nodes"},
            {"name": "containers", "endpoint": "/api/swarm/containers", "description": "Docker container management"},
            {"name": "services", "endpoint": "/api/swarm/services", "description": "Swarm services"},
            {"name": "vision", "endpoint": "/api/vision", "description": "Image/video generation"},
            {"name": "generate", "endpoint": "/api/fleet/generate", "description": "Direct image generation"},
            {"name": "ssh", "endpoint": "/api/ssh", "description": "Remote command execution"},
            {"name": "metrics", "endpoint": "/api/nodes", "description": "Node metrics and monitoring"},
        ]
    }


# =============================================================================
# Image Generation API (Direct to SDXL-TRT)
# =============================================================================

class GenerateRequest(BaseModel):
    """Image generation request."""
    prompt: str
    negative_prompt: Optional[str] = "blurry, bad quality, worst quality"
    width: int = 1024
    height: int = 1024
    steps: int = 20
    guidance_scale: float = 7.5
    seed: Optional[int] = None


class GenerateResponse(BaseModel):
    """Generation response with base64 image."""
    status: str
    seed: int
    filename: str
    image_base64: Optional[str] = None
    image_url: Optional[str] = None


@router.post("/generate")
async def generate_image(request: GenerateRequest):
    """Generate an image using SDXL-TRT on the GPU cluster.

    Returns the image as PNG stream.
    """
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            response = await client.post(
                f"{SDXL_ENDPOINT}/generate/sync",
                json={
                    "prompt": request.prompt,
                    "negative_prompt": request.negative_prompt,
                    "width": request.width,
                    "height": request.height,
                    "steps": request.steps,
                    "guidance_scale": request.guidance_scale,
                    "seed": request.seed,
                }
            )

            if response.status_code != 200:
                raise HTTPException(
                    status_code=response.status_code,
                    detail=f"SDXL generation failed: {response.text}"
                )

            # Get seed and filename from headers
            seed = response.headers.get("X-Seed", "0")
            filename = response.headers.get("X-Filename", "generated.png")

            # Return the image as stream
            return StreamingResponse(
                io.BytesIO(response.content),
                media_type="image/png",
                headers={
                    "X-Seed": seed,
                    "X-Filename": filename,
                    "Content-Disposition": f"inline; filename={filename}"
                }
            )
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Generation timed out")
    except httpx.ConnectError:
        raise HTTPException(status_code=503, detail=f"Cannot connect to SDXL service at {SDXL_ENDPOINT}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/generate/status")
async def generation_status():
    """Check SDXL service status."""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.get(f"{SDXL_ENDPOINT}/health")
            if response.status_code == 200:
                data = response.json()
                return {
                    "status": "online",
                    "endpoint": SDXL_ENDPOINT,
                    "model_loaded": data.get("model_loaded", False),
                    "current_model": data.get("current_model"),
                }
    except Exception as e:
        pass

    return {
        "status": "offline",
        "endpoint": SDXL_ENDPOINT,
        "error": "Cannot connect to SDXL service"
    }


# =============================================================================
# Deploy API - Deploy containers to nodes via SSH (bypasses broken Swarm GPU)
# =============================================================================

class DeployRequest(BaseModel):
    """Deploy container to a node."""
    node_id: str  # Node to deploy to
    image: str  # Docker image (e.g., 192.168.1.214:5000/sdxl-trt:r35.3.1)
    name: str  # Container name
    port: int = 8080  # Container port to expose
    host_port: int = 8080  # Host port
    env: Optional[dict] = {}  # Environment variables
    mounts: Optional[list] = []  # Volume mounts (list of "host:container" strings)
    gpus: bool = True  # Use GPU
    privileged: bool = False  # Run in privileged mode (for desktop containers)


@router.post("/deploy")
async def deploy_container(request: DeployRequest):
    """Deploy a container to a node via SSH docker run."""
    import asyncssh
    import redis.asyncio as redis
    from config import settings
    import json

    r = redis.from_url(settings.REDIS_URL, decode_responses=True)

    # Get node IP from Redis
    heartbeat = await r.get(f"node:{request.node_id}:heartbeat")
    if not heartbeat:
        raise HTTPException(status_code=404, detail=f"Node {request.node_id} not found")

    node_data = json.loads(heartbeat)
    node_ip = node_data.get('ip')

    if not node_ip:
        raise HTTPException(status_code=400, detail="Node IP not found")

    # Build docker run command (use sudo for compatibility)
    cmd_parts = ["sudo", "docker", "run", "-d", "--name", request.name]

    if request.privileged:
        cmd_parts.append("--privileged")

    if request.gpus:
        cmd_parts.extend(["--gpus", "all"])

    cmd_parts.extend(["-p", f"{request.host_port}:{request.port}"])

    for key, val in (request.env or {}).items():
        cmd_parts.extend(["-e", f"{key}={val}"])

    for mount in (request.mounts or []):
        cmd_parts.extend(["-v", mount])

    cmd_parts.append(request.image)
    docker_cmd = " ".join(cmd_parts)

    # Execute via SSH
    try:
        async with asyncssh.connect(
            node_ip, port=22,
            username='nvidia', password='nvidia',
            known_hosts=None, connect_timeout=10
        ) as conn:
            # Configure insecure registry if needed (using sudo with password)
            await conn.run("echo nvidia | sudo -S mkdir -p /etc/docker && echo '{\"insecure-registries\":[\"192.168.1.214:5000\"]}' | sudo tee /etc/docker/daemon.json > /dev/null && echo nvidia | sudo -S systemctl restart docker 2>/dev/null || true", timeout=60)

            # First pull the image (try without sudo first, then with)
            pull_result = await conn.run(f"docker pull {request.image} 2>/dev/null || echo nvidia | sudo -S docker pull {request.image}", timeout=300)

            # Remove existing container if any
            await conn.run(f"docker rm -f {request.name} 2>/dev/null || echo nvidia | sudo -S docker rm -f {request.name} 2>/dev/null || true", timeout=10)

            # Run the container (try without sudo first, then with password)
            result = await conn.run(f"{docker_cmd} 2>/dev/null || echo nvidia | sudo -S {docker_cmd}", timeout=60)

            if result.exit_status == 0:
                return {
                    "status": "deployed",
                    "node": request.node_id,
                    "ip": node_ip,
                    "container": request.name,
                    "port": request.host_port,
                    "url": f"http://{node_ip}:{request.host_port}"
                }
            else:
                raise HTTPException(
                    status_code=500,
                    detail=f"Deploy failed: {result.stderr}"
                )
    except asyncssh.PermissionDenied:
        raise HTTPException(status_code=401, detail="SSH permission denied")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/deploy/{node_id}/{container_name}")
async def remove_container(node_id: str, container_name: str):
    """Remove a container from a node."""
    import asyncssh
    import redis.asyncio as redis
    from config import settings
    import json

    r = redis.from_url(settings.REDIS_URL, decode_responses=True)

    heartbeat = await r.get(f"node:{node_id}:heartbeat")
    if not heartbeat:
        raise HTTPException(status_code=404, detail=f"Node {node_id} not found")

    node_data = json.loads(heartbeat)
    node_ip = node_data.get('ip')

    try:
        async with asyncssh.connect(
            node_ip, port=22,
            username='nvidia', password='nvidia',
            known_hosts=None, connect_timeout=10
        ) as conn:
            result = await conn.run(f"docker rm -f {container_name}", timeout=30)
            return {
                "status": "removed",
                "node": node_id,
                "container": container_name
            }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


class ExecRequest(BaseModel):
    """Execute command on a node."""
    command: str


@router.post("/exec/{node_id}")
async def exec_on_node(node_id: str, request: ExecRequest):
    """Execute a command on a node via SSH."""
    import asyncssh
    import redis.asyncio as redis
    from config import settings
    import json

    r = redis.from_url(settings.REDIS_URL, decode_responses=True)

    heartbeat = await r.get(f"node:{node_id}:heartbeat")
    if not heartbeat:
        raise HTTPException(status_code=404, detail=f"Node {node_id} not found")

    node_data = json.loads(heartbeat)
    node_ip = node_data.get('ip')

    try:
        async with asyncssh.connect(
            node_ip, port=22,
            username='nvidia', password='nvidia',
            known_hosts=None, connect_timeout=10
        ) as conn:
            result = await conn.run(
                f"{request.command} 2>&1 || echo nvidia | sudo -S {request.command} 2>&1",
                timeout=120
            )
            return {
                "node": node_id,
                "command": request.command,
                "output": result.stdout,
                "exit_code": result.exit_status
            }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/logs/{node_id}/{container_name}")
async def get_container_logs(node_id: str, container_name: str, tail: int = 50):
    """Get container logs from a node."""
    import asyncssh
    import redis.asyncio as redis
    from config import settings
    import json

    r = redis.from_url(settings.REDIS_URL, decode_responses=True)

    heartbeat = await r.get(f"node:{node_id}:heartbeat")
    if not heartbeat:
        raise HTTPException(status_code=404, detail=f"Node {node_id} not found")

    node_data = json.loads(heartbeat)
    node_ip = node_data.get('ip')

    try:
        async with asyncssh.connect(
            node_ip, port=22,
            username='nvidia', password='nvidia',
            known_hosts=None, connect_timeout=10
        ) as conn:
            result = await conn.run(
                f"docker logs {container_name} --tail {tail} 2>&1 || echo nvidia | sudo -S docker logs {container_name} --tail {tail} 2>&1",
                timeout=30
            )
            return {
                "node": node_id,
                "container": container_name,
                "logs": result.stdout
            }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
