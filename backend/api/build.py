"""
Build API - Centralized builds on Spark, deploy to AGX nodes
All builds happen on Spark (DGX), images are pushed to local registry,
AGX nodes pull pre-built images. This keeps AGX nodes clean.
"""
import asyncio
import os
import uuid
from fastapi import APIRouter, HTTPException, BackgroundTasks
from pydantic import BaseModel
from typing import List, Optional, Dict, Any
import redis.asyncio as redis
import json
import docker
from config import settings

router = APIRouter()
r = redis.from_url(settings.REDIS_URL, decode_responses=True)

# Local Docker client (on Spark)
docker_client = docker.from_env()

# Registry URL (Spark hosts the registry)
REGISTRY_URL = os.getenv("REGISTRY_URL", "192.168.1.214:5000")

class BuildRequest(BaseModel):
    name: str  # Image name
    dockerfile_content: Optional[str] = None  # Inline Dockerfile
    dockerfile_path: Optional[str] = None  # Path to Dockerfile
    context_path: str = "."  # Build context
    tag: str = "latest"
    build_args: Optional[Dict[str, str]] = None
    push_to_registry: bool = True

class DeployRequest(BaseModel):
    image: str  # Full image name (registry/name:tag)
    service_name: str
    replicas: int = 1
    target_nodes: Optional[List[str]] = None  # Node IDs to deploy to
    env: Optional[List[str]] = None
    mounts: Optional[List[Dict[str, str]]] = None
    ports: Optional[List[Dict[str, int]]] = None
    gpu: bool = False  # Request GPU access

class BuildAndDeployRequest(BaseModel):
    name: str
    dockerfile_content: str
    tag: str = "latest"
    service_name: str
    replicas: int = 1
    target_nodes: Optional[List[str]] = None
    env: Optional[List[str]] = None
    gpu: bool = False

@router.post("/build")
async def build_image(req: BuildRequest, background_tasks: BackgroundTasks):
    """Build a Docker image on Spark."""
    task_id = str(uuid.uuid4())

    await r.hset(f"build:{task_id}", mapping={
        "status": "building",
        "name": req.name,
        "tag": req.tag,
        "log": ""
    })

    background_tasks.add_task(run_build, task_id, req)
    return {"task_id": task_id, "status": "building"}

async def run_build(task_id: str, req: BuildRequest):
    """Execute the build process."""
    logs = []
    try:
        image_tag = f"{REGISTRY_URL}/{req.name}:{req.tag}"
        logs.append(f"Building image: {image_tag}")

        # Build the image
        if req.dockerfile_content:
            # Create temp Dockerfile
            import tempfile
            with tempfile.NamedTemporaryFile(mode='w', suffix='Dockerfile', delete=False) as f:
                f.write(req.dockerfile_content)
                dockerfile_path = f.name

            image, build_logs = docker_client.images.build(
                path=req.context_path,
                dockerfile=dockerfile_path,
                tag=image_tag,
                buildargs=req.build_args or {},
                rm=True
            )
            os.unlink(dockerfile_path)
        else:
            image, build_logs = docker_client.images.build(
                path=req.context_path,
                dockerfile=req.dockerfile_path or "Dockerfile",
                tag=image_tag,
                buildargs=req.build_args or {},
                rm=True
            )

        for log in build_logs:
            if 'stream' in log:
                logs.append(log['stream'].strip())

        logs.append(f"Build complete: {image.id}")

        # Push to registry if requested
        if req.push_to_registry:
            logs.append(f"Pushing to registry: {REGISTRY_URL}")
            push_logs = docker_client.images.push(image_tag, stream=True, decode=True)
            for log in push_logs:
                if 'status' in log:
                    logs.append(log['status'])
            logs.append("Push complete!")

        await r.hset(f"build:{task_id}", mapping={
            "status": "completed",
            "image": image_tag,
            "log": "\n".join(logs)
        })

    except Exception as e:
        logs.append(f"ERROR: {str(e)}")
        await r.hset(f"build:{task_id}", mapping={
            "status": "error",
            "error": str(e),
            "log": "\n".join(logs)
        })

@router.get("/build/{task_id}")
async def get_build_status(task_id: str):
    """Get build task status."""
    task = await r.hgetall(f"build:{task_id}")
    if not task:
        raise HTTPException(status_code=404, detail="Build task not found")
    return task

@router.post("/deploy")
async def deploy_service(req: DeployRequest):
    """Deploy a pre-built image to AGX nodes via Swarm."""
    try:
        # Build placement constraints
        constraints = []
        if req.target_nodes:
            # Deploy to specific nodes
            node_constraints = [f"node.hostname=={node}" for node in req.target_nodes]
            # Use OR logic - place on any of the specified nodes
            constraints.append(f"node.hostname=={req.target_nodes[0]}")

        # Build resource spec for GPU
        resources = None
        if req.gpu:
            resources = docker.types.Resources(
                generic_resources=[
                    docker.types.GenericResource('gpu', '1')
                ]
            )

        # Build mounts - always include S3 mounts for models and outputs
        mounts = req.mounts or []
        default_mounts = [
            {"source": "/mnt/s3-models", "target": "/models", "type": "bind", "read_only": True},
            {"source": "/mnt/s3-outputs", "target": "/outputs", "type": "bind"},
        ]
        mounts.extend(default_mounts)

        # Create service
        service = docker_client.services.create(
            image=req.image,
            name=req.service_name,
            mode=docker.types.ServiceMode('replicated', replicas=req.replicas),
            constraints=constraints if constraints else None,
            env=req.env,
            mounts=[
                docker.types.Mount(
                    target=m['target'],
                    source=m['source'],
                    type=m.get('type', 'bind'),
                    read_only=m.get('read_only', False)
                ) for m in mounts
            ],
            endpoint_spec=docker.types.EndpointSpec(
                ports={p['target_port']: p['published_port'] for p in (req.ports or [])}
            ) if req.ports else None,
            resources=resources
        )

        return {
            "status": "deployed",
            "service_id": service.id,
            "service_name": req.service_name,
            "image": req.image,
            "mounts": ["/mnt/s3-models -> /models (ro)", "/mnt/s3-outputs -> /outputs (rw)"]
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/build-and-deploy")
async def build_and_deploy(req: BuildAndDeployRequest, background_tasks: BackgroundTasks):
    """Build on Spark and deploy to AGX in one step."""
    task_id = str(uuid.uuid4())

    await r.hset(f"build-deploy:{task_id}", mapping={
        "status": "building",
        "name": req.name,
        "service_name": req.service_name,
        "log": ""
    })

    background_tasks.add_task(run_build_and_deploy, task_id, req)
    return {"task_id": task_id, "status": "building"}

async def run_build_and_deploy(task_id: str, req: BuildAndDeployRequest):
    """Build and deploy in sequence."""
    logs = []
    try:
        image_tag = f"{REGISTRY_URL}/{req.name}:{req.tag}"
        logs.append(f"=== PHASE 1: Building on Spark ===")
        logs.append(f"Image: {image_tag}")

        # Build
        import tempfile
        with tempfile.NamedTemporaryFile(mode='w', suffix='Dockerfile', delete=False) as f:
            f.write(req.dockerfile_content)
            dockerfile_path = f.name

        image, build_logs = docker_client.images.build(
            path="/tmp",
            dockerfile=dockerfile_path,
            tag=image_tag,
            rm=True
        )
        os.unlink(dockerfile_path)

        logs.append(f"Build complete: {image.short_id}")

        # Push
        logs.append(f"Pushing to registry...")
        docker_client.images.push(image_tag)
        logs.append("Push complete!")

        await r.hset(f"build-deploy:{task_id}", mapping={
            "status": "deploying",
            "log": "\n".join(logs)
        })

        # Deploy
        logs.append(f"\n=== PHASE 2: Deploying to AGX ===")

        constraints = []
        if req.target_nodes:
            constraints = [f"node.hostname=={req.target_nodes[0]}"]

        # Always mount S3 for models and outputs
        mounts = [
            docker.types.Mount("/models", "/mnt/s3-models", type="bind", read_only=True),
            docker.types.Mount("/outputs", "/mnt/s3-outputs", type="bind"),
        ]

        service = docker_client.services.create(
            image=image_tag,
            name=req.service_name,
            mode=docker.types.ServiceMode('replicated', replicas=req.replicas),
            constraints=constraints if constraints else None,
            env=req.env,
            mounts=mounts
        )

        logs.append(f"Service created: {service.id}")
        logs.append(f"Replicas: {req.replicas}")
        logs.append(f"\n=== Storage Mounts ===")
        logs.append(f"  /models  <- S3://fleet-models (read-only)")
        logs.append(f"  /outputs -> S3://fleet-outputs (read-write)")
        logs.append(f"\nAll generated content will be saved to S3, AGX stays clean!")

        await r.hset(f"build-deploy:{task_id}", mapping={
            "status": "completed",
            "service_id": service.id,
            "image": image_tag,
            "log": "\n".join(logs)
        })

    except Exception as e:
        logs.append(f"\nERROR: {str(e)}")
        await r.hset(f"build-deploy:{task_id}", mapping={
            "status": "error",
            "error": str(e),
            "log": "\n".join(logs)
        })

@router.get("/build-and-deploy/{task_id}")
async def get_build_deploy_status(task_id: str):
    """Get build-and-deploy task status."""
    task = await r.hgetall(f"build-deploy:{task_id}")
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    return task

@router.get("/registry/images")
async def list_registry_images():
    """List images in the local registry by querying the registry catalog."""
    import httpx

    try:
        # Fetch catalog from registry
        async with httpx.AsyncClient(timeout=10) as client:
            catalog_res = await client.get(f"http://{REGISTRY_URL}/v2/_catalog")
            catalog = catalog_res.json()
            repos = catalog.get('repositories', [])

            images = []
            for repo in repos:
                try:
                    tags_res = await client.get(f"http://{REGISTRY_URL}/v2/{repo}/tags/list")
                    tags_data = tags_res.json()
                    tags = tags_data.get('tags', [])

                    images.append({
                        "name": repo,
                        "tags": tags,
                        "full_image": f"{REGISTRY_URL}/{repo}"
                    })
                except Exception as e:
                    print(f"Failed to get tags for {repo}: {e}")

            return {"images": images, "registry": REGISTRY_URL}

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
