"""
Vision Cluster Smart Scheduler API

Endpoints for managing the intelligent queue and model routing system.
"""
from fastapi import APIRouter, HTTPException, BackgroundTasks
from pydantic import BaseModel
from typing import List, Optional, Dict, Any
from fastapi.responses import FileResponse
import uuid
import time

from services.smart_scheduler import (
    get_scheduler,
    get_cluster_status,
    QueueJob,
    VisionNode,
    JobStatus,
)

router = APIRouter()


class GenerateRequest(BaseModel):
    """Image generation request."""
    prompt: str
    negative_prompt: Optional[str] = ""
    width: int = 1024
    height: int = 1024
    steps: int = 20
    guidance_scale: float = 7.5
    seed: Optional[int] = None
    model: str = "SDXL_4GB_FP8.safetensors"  # Target model
    lora: Optional[str] = None
    lora_strength: float = 0.8
    priority: int = 0  # Higher = more priority


class NodeHeartbeat(BaseModel):
    """Heartbeat from a vision node."""
    node_id: str
    hostname: str
    ip: str
    port: int = 8080
    current_model: Optional[str] = None
    gpu_util: int = 0
    status: str = "online"


class NodeRegister(BaseModel):
    """Register a new vision node."""
    hostname: str
    ip: str
    port: int = 8080


@router.get("/status")
async def cluster_status():
    """Get current vision cluster status.

    Returns:
        - Node counts (online, busy, switching, offline)
        - Queue length
        - Which models are loaded on which nodes
    """
    return await get_cluster_status()


@router.get("/nodes")
async def list_nodes():
    """List all registered vision nodes."""
    scheduler = await get_scheduler()
    nodes = await scheduler.get_nodes()
    return {
        "nodes": [
            {
                "node_id": n.node_id,
                "hostname": n.hostname,
                "ip": n.ip,
                "port": n.port,
                "current_model": n.current_model,
                "status": n.status,
                "gpu_util": n.gpu_util,
                "is_available": n.is_available,
                "is_online": n.is_online,
            }
            for n in nodes
        ],
        "total": len(nodes),
    }


@router.post("/nodes/register")
async def register_node(req: NodeRegister):
    """Register a new vision node."""
    scheduler = await get_scheduler()
    node_id = f"{req.hostname}-{int(time.time())}"
    node = VisionNode(
        node_id=node_id,
        hostname=req.hostname,
        ip=req.ip,
        port=req.port,
        status="online",
        last_heartbeat=time.time(),
    )
    await scheduler.register_node(node)
    return {"status": "registered", "node_id": node_id}


@router.post("/nodes/heartbeat")
async def node_heartbeat(req: NodeHeartbeat):
    """Receive heartbeat from a vision node.

    Nodes should call this every 10 seconds with their current status.
    """
    scheduler = await get_scheduler()
    await scheduler.update_node_heartbeat(
        node_id=req.node_id,
        current_model=req.current_model,
        gpu_util=req.gpu_util,
        status=req.status,
    )
    return {"status": "ok"}


@router.post("/generate")
async def queue_generation(req: GenerateRequest, background_tasks: BackgroundTasks):
    """Queue an image generation request.

    The smart scheduler will:
    1. Check if any node has the requested model loaded
    2. If yes, route to that node
    3. If no, switch the least busy node to that model
    4. Return job ID for status tracking

    Returns:
        job_id: UUID to track the job
    """
    scheduler = await get_scheduler()

    # Create job
    job_id = str(uuid.uuid4())
    job = QueueJob(
        job_id=job_id,
        request_data={
            "prompt": req.prompt,
            "negative_prompt": req.negative_prompt,
            "width": req.width,
            "height": req.height,
            "steps": req.steps,
            "guidance_scale": req.guidance_scale,
            "seed": req.seed,
            "lora": req.lora,
            "lora_strength": req.lora_strength,
        },
        target_model=req.model,
        priority=req.priority,
    )

    await scheduler.enqueue_job(job)

    # Get queue position
    queue_length = await scheduler.get_queue_length()

    return {
        "job_id": job_id,
        "status": "queued",
        "queue_position": queue_length,
        "target_model": req.model,
    }


@router.get("/queue")
async def get_queue():
    """Get current queue status."""
    scheduler = await get_scheduler()
    queue_length = await scheduler.get_queue_length()
    jobs = await scheduler.get_queue_jobs(limit=50)

    return {
        "pending": queue_length,
        "jobs": jobs,
    }


@router.get("/jobs/{job_id}")
async def get_job_status(job_id: str):
    """Get status of a specific job."""
    # This would need job tracking storage
    # For now return a placeholder
    return {
        "job_id": job_id,
        "status": "unknown",
        "message": "Job tracking not yet implemented",
    }


@router.get("/models/available")
async def available_models():
    """Get list of available models for generation.

    Returns models available on S3 that can be loaded.
    """
    # This connects to MinIO to list available models
    import httpx

    try:
        # Check if any node is available to query for S3 models
        scheduler = await get_scheduler()
        nodes = await scheduler.get_nodes()

        for node in nodes:
            if node.is_online:
                try:
                    async with httpx.AsyncClient(timeout=10.0) as client:
                        response = await client.get(
                            f"http://{node.ip}:{node.port}/models/s3"
                        )
                        if response.status_code == 200:
                            return response.json()
                except Exception:
                    continue

        # Fallback - hardcoded known models
        return {
            "models": [
                {"name": "SDXL_4GB_FP8.safetensors", "size_gb": 4.1},
                {"name": "RealVisXL_V5_Turbo.safetensors", "size_gb": 2.4},
            ],
            "source": "fallback",
        }
    except Exception as e:
        return {"error": str(e), "models": []}


@router.get("/models/loaded")
async def loaded_models():
    """Get which models are currently loaded on which nodes."""
    status = await get_cluster_status()
    return {
        "models_loaded": status.get("models_loaded", {}),
    }


@router.post("/models/switch/{node_id}")
async def switch_node_model(node_id: str, model_name: str):
    """Manually switch a specific node's model.

    Use this to pre-load a model on a node before jobs arrive.
    """
    scheduler = await get_scheduler()
    nodes = await scheduler.get_nodes()

    node = next((n for n in nodes if n.node_id == node_id), None)
    if not node:
        raise HTTPException(status_code=404, detail=f"Node {node_id} not found")

    if not node.is_online:
        raise HTTPException(status_code=400, detail=f"Node {node_id} is not online")

    success = await scheduler.switch_node_model(node, model_name)
    if success:
        return {"status": "switching", "node": node_id, "model": model_name}
    else:
        raise HTTPException(status_code=500, detail="Failed to initiate model switch")


@router.post("/balance")
async def balance_models():
    """Automatically balance models across nodes.

    This will distribute models evenly so different models are available
    without needing to switch.
    """
    # Get available models and nodes
    scheduler = await get_scheduler()
    nodes = await scheduler.get_nodes()
    online_nodes = [n for n in nodes if n.is_online]

    if len(online_nodes) < 2:
        return {"status": "skipped", "reason": "Need at least 2 online nodes"}

    # Get available models (hardcoded for now)
    models = ["SDXL_4GB_FP8.safetensors", "RealVisXL_V5_Turbo.safetensors"]

    # Assign models round-robin
    assignments = []
    for i, node in enumerate(online_nodes):
        target_model = models[i % len(models)]
        if node.current_model != target_model:
            # Queue a model switch
            await scheduler.switch_node_model(node, target_model)
            assignments.append({
                "node": node.hostname,
                "switching_to": target_model,
            })

    return {
        "status": "balancing",
        "assignments": assignments,
    }


# =============================================================================
# LoRA Management (Cluster-Wide)
# =============================================================================

@router.get("/loras")
async def list_loras():
    """List all available LoRAs from S3 storage."""
    import httpx
    from pathlib import Path

    # Try to get from S3 mount directly first
    lora_path = Path("/data/fleet-loras")
    if lora_path.exists():
        loras = []
        for item in lora_path.iterdir():
            if item.suffix == ".safetensors":
                loras.append({
                    "name": item.stem,
                    "filename": item.name,
                    "size_mb": round(item.stat().st_size / (1024*1024), 2),
                })
        return {"loras": loras, "total": len(loras), "source": "s3"}

    # Fallback: Query a node
    try:
        scheduler = await get_scheduler()
        nodes = await scheduler.get_nodes()

        for node in nodes:
            if node.is_online:
                try:
                    async with httpx.AsyncClient(timeout=10.0) as client:
                        response = await client.get(f"http://{node.ip}:{node.port}/loras/s3")
                        if response.status_code == 200:
                            return response.json()
                except Exception:
                    continue
    except Exception as e:
        pass

    return {"loras": [], "total": 0, "error": "No nodes available"}


@router.post("/loras/upload")
async def upload_lora(file: Any = None):
    """Upload a LoRA file to S3 storage."""
    # This would need file upload handling
    # For now, instruct to upload directly to S3
    return {
        "status": "info",
        "message": "Upload LoRAs directly to MinIO bucket 'fleet-loras' or use mc command",
        "example": "mc cp my_lora.safetensors spark/fleet-loras/"
    }


# =============================================================================
# Gallery & Outputs (Cluster-Wide from S3)
# =============================================================================

@router.get("/gallery")
async def get_gallery(limit: int = 100, offset: int = 0):
    """Get gallery of generated images from S3 outputs."""
    from pathlib import Path

    output_path = Path("/data/fleet-outputs")
    if not output_path.exists():
        return {"images": [], "total": 0, "error": "Output path not found"}

    # Get all image files sorted by modification time (newest first)
    images = []
    all_files = sorted(
        [f for f in output_path.iterdir() if f.suffix.lower() in ['.png', '.jpg', '.jpeg', '.webp']],
        key=lambda x: x.stat().st_mtime,
        reverse=True
    )

    total = len(all_files)

    for item in all_files[offset:offset + limit]:
        stat = item.stat()
        images.append({
            "filename": item.name,
            "size_kb": round(stat.st_size / 1024, 2),
            "created_at": stat.st_mtime,
            "url": f"/api/vision/outputs/{item.name}",
        })

    return {
        "images": images,
        "total": total,
        "limit": limit,
        "offset": offset,
    }


@router.get("/outputs")
async def list_outputs(limit: int = 50):
    """List output images from S3."""
    return await get_gallery(limit=limit)


@router.get("/outputs/{filename}")
async def get_output_image(filename: str):
    """Get a specific output image from S3."""
    from pathlib import Path

    output_path = Path("/data/fleet-outputs") / filename
    if not output_path.exists():
        raise HTTPException(status_code=404, detail="Image not found")

    return FileResponse(
        path=str(output_path),
        media_type="image/png",
        filename=filename
    )


@router.delete("/outputs/{filename}")
async def delete_output(filename: str):
    """Delete an output image from S3."""
    from pathlib import Path

    output_path = Path("/data/fleet-outputs") / filename
    if not output_path.exists():
        raise HTTPException(status_code=404, detail="Image not found")

    try:
        output_path.unlink()
        return {"status": "deleted", "filename": filename}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/outputs/clear")
async def clear_outputs():
    """Clear all output images from S3."""
    from pathlib import Path

    output_path = Path("/data/fleet-outputs")
    if not output_path.exists():
        return {"status": "ok", "deleted": 0}

    deleted = 0
    for item in output_path.iterdir():
        if item.suffix.lower() in ['.png', '.jpg', '.jpeg', '.webp']:
            try:
                item.unlink()
                deleted += 1
            except Exception:
                pass

    return {"status": "cleared", "deleted": deleted}


# =============================================================================
# Job Tracking (Improved)
# =============================================================================

# In-memory job tracking (would be Redis in production)
_job_registry: Dict[str, Dict[str, Any]] = {}


@router.get("/jobs")
async def list_jobs(status: Optional[str] = None, limit: int = 50):
    """List all jobs across the cluster."""
    import httpx

    all_jobs = []

    # Query each online node for its jobs
    try:
        scheduler = await get_scheduler()
        nodes = await scheduler.get_nodes()

        for node in nodes:
            if node.is_online:
                try:
                    async with httpx.AsyncClient(timeout=5.0) as client:
                        response = await client.get(f"http://{node.ip}:{node.port}/jobs")
                        if response.status_code == 200:
                            node_jobs = response.json()
                            for job in node_jobs.get("jobs", []):
                                job["node_id"] = node.node_id
                                job["node_hostname"] = node.hostname
                                all_jobs.append(job)
                except Exception:
                    continue
    except Exception:
        pass

    # Filter by status if specified
    if status:
        all_jobs = [j for j in all_jobs if j.get("status") == status]

    # Sort by created_at (newest first)
    all_jobs.sort(key=lambda x: x.get("created_at", ""), reverse=True)

    return {
        "jobs": all_jobs[:limit],
        "total": len(all_jobs),
    }


@router.post("/jobs/{job_id}/cancel")
async def cancel_job(job_id: str):
    """Cancel a job on any node."""
    import httpx

    # Find which node has this job
    try:
        scheduler = await get_scheduler()
        nodes = await scheduler.get_nodes()

        for node in nodes:
            if node.is_online:
                try:
                    async with httpx.AsyncClient(timeout=5.0) as client:
                        response = await client.post(f"http://{node.ip}:{node.port}/cancel/{job_id}")
                        if response.status_code == 200:
                            return {"status": "cancelled", "job_id": job_id, "node": node.hostname}
                except Exception:
                    continue
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    raise HTTPException(status_code=404, detail="Job not found on any node")


@router.post("/jobs/stop-all")
async def stop_all_jobs():
    """Stop all jobs on all nodes."""
    import httpx

    stopped_nodes = []

    try:
        scheduler = await get_scheduler()
        nodes = await scheduler.get_nodes()

        for node in nodes:
            if node.is_online:
                try:
                    async with httpx.AsyncClient(timeout=5.0) as client:
                        response = await client.post(f"http://{node.ip}:{node.port}/stop-all")
                        if response.status_code == 200:
                            stopped_nodes.append(node.hostname)
                except Exception:
                    continue
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    return {"status": "stopped", "nodes": stopped_nodes}


# =============================================================================
# System Info (Cluster-Wide)
# =============================================================================

@router.get("/system")
async def cluster_system_info():
    """Get aggregated system info from all nodes including JetPack versions."""
    import httpx
    import redis.asyncio as redis_client
    import json
    from config import settings

    cluster_info = {
        "nodes": [],
        "total_gpu_memory_gb": 0,
        "total_used_memory_gb": 0,
        "total_nodes": 0,
        "online_nodes": 0,
        "busy_nodes": 0,
    }

    # Get JetPack info from Redis heartbeats
    jetpack_map = {}
    try:
        r = redis_client.from_url(settings.REDIS_URL, decode_responses=True)
        node_ids = await r.smembers("nodes:active")
        for nid in node_ids:
            data = await r.get(f"node:{nid}:heartbeat")
            if data:
                node_data = json.loads(data)
                jetpack_map[node_data.get("ip", "")] = node_data.get("jetpack", {})
        await r.close()
    except Exception:
        pass

    try:
        scheduler = await get_scheduler()
        nodes = await scheduler.get_nodes()
        cluster_info["total_nodes"] = len(nodes)

        for node in nodes:
            # Get JetPack info from Redis data
            jetpack = jetpack_map.get(node.ip, {})

            node_info = {
                "node_id": node.node_id,
                "hostname": node.hostname,
                "ip": node.ip,
                "status": node.status,
                "current_model": node.current_model,
                "gpu_util": node.gpu_util,
                "jetpack_version": jetpack.get("jetpack_version"),
                "l4t_version": jetpack.get("l4t_version"),
                "board": jetpack.get("board"),
            }

            if node.is_online:
                cluster_info["online_nodes"] += 1

                if node.status == "busy":
                    cluster_info["busy_nodes"] += 1

                # Try to get detailed info from node
                try:
                    async with httpx.AsyncClient(timeout=5.0) as client:
                        response = await client.get(f"http://{node.ip}:{node.port}/info")
                        if response.status_code == 200:
                            info = response.json()
                            node_info["gpu_name"] = info.get("gpu_name", "Unknown")
                            node_info["gpu_memory_gb"] = info.get("gpu_memory_gb", 0)
                            node_info["models_available"] = info.get("models_available", 0)
                            cluster_info["total_gpu_memory_gb"] += info.get("gpu_memory_gb", 0)
                except Exception:
                    node_info["gpu_name"] = "Unknown"
                    node_info["gpu_memory_gb"] = 0

            cluster_info["nodes"].append(node_info)
    except Exception as e:
        cluster_info["error"] = str(e)

    return cluster_info


@router.get("/system/gpu")
async def cluster_gpu_stats():
    """Get GPU stats from all nodes."""
    import httpx

    gpu_stats = []

    try:
        scheduler = await get_scheduler()
        nodes = await scheduler.get_nodes()

        for node in nodes:
            if node.is_online:
                try:
                    async with httpx.AsyncClient(timeout=5.0) as client:
                        response = await client.get(f"http://{node.ip}:{node.port}/system/gpu")
                        if response.status_code == 200:
                            stats = response.json()
                            stats["node_id"] = node.node_id
                            stats["hostname"] = node.hostname
                            gpu_stats.append(stats)
                except Exception:
                    gpu_stats.append({
                        "node_id": node.node_id,
                        "hostname": node.hostname,
                        "error": "Failed to get GPU stats"
                    })
    except Exception as e:
        return {"error": str(e), "gpu_stats": []}

    return {"gpu_stats": gpu_stats, "total_nodes": len(gpu_stats)}


# =============================================================================
# Node Direct Access (Proxy to specific node)
# =============================================================================

@router.get("/nodes/{node_id}/info")
async def get_node_info(node_id: str):
    """Get detailed info from a specific node."""
    import httpx

    scheduler = await get_scheduler()
    nodes = await scheduler.get_nodes()

    node = next((n for n in nodes if n.node_id == node_id or n.hostname == node_id), None)
    if not node:
        raise HTTPException(status_code=404, detail="Node not found")

    if not node.is_online:
        raise HTTPException(status_code=400, detail="Node is offline")

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(f"http://{node.ip}:{node.port}/info")
            if response.status_code == 200:
                info = response.json()
                info["node_id"] = node.node_id
                return info
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/nodes/{node_id}/models")
async def get_node_models(node_id: str):
    """Get available models on a specific node."""
    import httpx

    scheduler = await get_scheduler()
    nodes = await scheduler.get_nodes()

    node = next((n for n in nodes if n.node_id == node_id or n.hostname == node_id), None)
    if not node:
        raise HTTPException(status_code=404, detail="Node not found")

    if not node.is_online:
        raise HTTPException(status_code=400, detail="Node is offline")

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(f"http://{node.ip}:{node.port}/models")
            return response.json()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/nodes/{node_id}/load")
async def load_model_on_node(node_id: str, model: str):
    """Load a specific model on a specific node."""
    import httpx

    scheduler = await get_scheduler()
    nodes = await scheduler.get_nodes()

    node = next((n for n in nodes if n.node_id == node_id or n.hostname == node_id), None)
    if not node:
        raise HTTPException(status_code=404, detail="Node not found")

    if not node.is_online:
        raise HTTPException(status_code=400, detail="Node is offline")

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                f"http://{node.ip}:{node.port}/load",
                json={"model": model}
            )
            return response.json()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/nodes/{node_id}/loading-status")
async def get_node_loading_status(node_id: str):
    """Get model loading status on a specific node."""
    import httpx

    scheduler = await get_scheduler()
    nodes = await scheduler.get_nodes()

    node = next((n for n in nodes if n.node_id == node_id or n.hostname == node_id), None)
    if not node:
        raise HTTPException(status_code=404, detail="Node not found")

    if not node.is_online:
        raise HTTPException(status_code=400, detail="Node is offline")

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(f"http://{node.ip}:{node.port}/loading-status")
            return response.json()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# =============================================================================
# Aspect Ratios & Schedulers (Static config)
# =============================================================================

@router.get("/aspect-ratios")
async def get_aspect_ratios():
    """Get available aspect ratio presets."""
    return {
        "1:1": [512, 512],
        "16:9": [768, 432],
        "9:16": [432, 768],
        "4:3": [640, 480],
        "3:4": [480, 640],
        "3:2": [768, 512],
        "2:3": [512, 768],
        "21:9": [896, 384],
        "9:21": [384, 896],
    }


@router.get("/schedulers")
async def get_schedulers():
    """Get available scheduler types."""
    return {
        "schedulers": [
            {"id": "euler_a", "name": "Euler Ancestral", "default": True},
            {"id": "euler", "name": "Euler"},
            {"id": "dpm++_2m", "name": "DPM++ 2M"},
            {"id": "dpm++_2m_karras", "name": "DPM++ 2M Karras"},
            {"id": "ddim", "name": "DDIM"},
            {"id": "lms", "name": "LMS"},
        ]
    }


# =============================================================================
# JetPack Version Info (Cluster-Wide)
# =============================================================================

@router.get("/nodes/jetpack")
async def get_cluster_jetpack_info():
    """Get JetPack/L4T version info for all nodes.

    Returns the JetPack version, L4T version, and board type for each
    AGX node in the cluster. This data comes from /etc/nv_tegra_release
    on each Jetson device.
    """
    import redis.asyncio as redis
    import json
    from config import settings

    r = redis.from_url(settings.REDIS_URL, decode_responses=True)
    jetpack_info = []

    try:
        node_ids = await r.smembers("nodes:active")

        for nid in node_ids:
            data = await r.get(f"node:{nid}:heartbeat")
            if data:
                node = json.loads(data)
                jetpack = node.get("jetpack", {})

                jetpack_info.append({
                    "node_id": nid,
                    "ip": node.get("ip"),
                    "jetpack_version": jetpack.get("jetpack_version"),
                    "l4t_version": jetpack.get("l4t_version"),
                    "l4t_release": jetpack.get("l4t_release"),
                    "l4t_revision": jetpack.get("l4t_revision"),
                    "board": jetpack.get("board"),
                })
    except Exception as e:
        return {"error": str(e), "nodes": []}
    finally:
        await r.close()

    return {
        "nodes": jetpack_info,
        "total": len(jetpack_info)
    }


@router.get("/nodes/{node_id}/jetpack")
async def get_node_jetpack_info(node_id: str):
    """Get JetPack/L4T version info for a specific node."""
    import redis.asyncio as redis
    import json
    from config import settings

    r = redis.from_url(settings.REDIS_URL, decode_responses=True)

    try:
        data = await r.get(f"node:{node_id}:heartbeat")
        if not data:
            raise HTTPException(status_code=404, detail="Node not found")

        node = json.loads(data)
        jetpack = node.get("jetpack", {})

        return {
            "node_id": node_id,
            "ip": node.get("ip"),
            "jetpack_version": jetpack.get("jetpack_version"),
            "l4t_version": jetpack.get("l4t_version"),
            "l4t_release": jetpack.get("l4t_release"),
            "l4t_revision": jetpack.get("l4t_revision"),
            "board": jetpack.get("board"),
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        await r.close()
