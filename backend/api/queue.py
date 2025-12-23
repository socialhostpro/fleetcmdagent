"""
Fleet Commander Redis Queue System
Handles job distribution to AGX nodes with priority queues and auto-scaling.
"""
import asyncio
from fastapi import APIRouter, HTTPException, BackgroundTasks
from pydantic import BaseModel, Field
from typing import Dict, Any, Optional, List
import redis.asyncio as redis
import json
from datetime import datetime, timedelta
import uuid
from enum import Enum
from config import settings

router = APIRouter()
r = redis.from_url(settings.REDIS_URL, decode_responses=True)

# Queue names by priority
QUEUE_HIGH = "fleet:queue:high"
QUEUE_NORMAL = "fleet:queue:normal"
QUEUE_LOW = "fleet:queue:low"
QUEUE_PROCESSING = "fleet:queue:processing"
QUEUE_COMPLETED = "fleet:queue:completed"
QUEUE_FAILED = "fleet:queue:failed"
QUEUE_DEAD_LETTER = "fleet:queue:dead_letter"

# Auto-scaling keys
SCALING_CONFIG = "fleet:scaling:config"
SCALING_STATE = "fleet:scaling:state"


class JobPriority(str, Enum):
    HIGH = "high"
    NORMAL = "normal"
    LOW = "low"


class JobType(str, Enum):
    IMAGE_GEN = "image_gen"  # ComfyUI image generation
    VIDEO_GEN = "video_gen"  # Video generation
    LLM_INFERENCE = "llm_inference"  # LLM/Ollama inference
    TRANSCRIPTION = "transcription"  # Audio transcription
    TRAINING = "training"  # Model training/fine-tuning
    CUSTOM = "custom"  # Custom workflow


class JobStatus(str, Enum):
    QUEUED = "queued"
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"
    DEAD = "dead"
    CANCELLED = "cancelled"


class JobCreate(BaseModel):
    job_type: JobType
    priority: JobPriority = JobPriority.NORMAL
    payload: Dict[str, Any]  # Job-specific data (workflow, prompt, etc.)
    target_cluster: Optional[str] = None  # e.g., "vision", "llm", "media-gen"
    target_node: Optional[str] = None  # Specific node ID
    max_retries: int = 3
    timeout_seconds: int = 3600  # 1 hour default
    callback_url: Optional[str] = None  # Webhook for completion


class JobResponse(BaseModel):
    job_id: str
    job_type: str
    status: str
    priority: str
    created_at: str
    started_at: Optional[str] = None
    completed_at: Optional[str] = None
    assigned_node: Optional[str] = None
    progress: float = 0.0
    result: Optional[Dict[str, Any]] = None
    error: Optional[str] = None
    retry_count: int = 0


class ScalingConfig(BaseModel):
    enabled: bool = True
    min_nodes: int = 1
    max_nodes: int = 16
    target_queue_depth: int = 10  # Scale up if queue exceeds this
    scale_up_threshold: float = 0.8  # GPU utilization to trigger scale up
    scale_down_threshold: float = 0.2  # GPU utilization to trigger scale down
    cooldown_seconds: int = 300  # Wait between scaling operations
    check_interval_seconds: int = 30  # How often to check for scaling


# ============== Job Queue Operations ==============

@router.post("/jobs")
async def create_job(job: JobCreate, background_tasks: BackgroundTasks):
    """Add a new job to the queue."""
    job_id = str(uuid.uuid4())
    now = datetime.utcnow().isoformat()

    job_data = {
        "job_id": job_id,
        "job_type": job.job_type.value,
        "priority": job.priority.value,
        "payload": job.payload,
        "target_cluster": job.target_cluster,
        "target_node": job.target_node,
        "max_retries": job.max_retries,
        "timeout_seconds": job.timeout_seconds,
        "callback_url": job.callback_url,
        "status": JobStatus.QUEUED.value,
        "created_at": now,
        "started_at": None,
        "completed_at": None,
        "assigned_node": None,
        "progress": 0.0,
        "result": None,
        "error": None,
        "retry_count": 0,
    }

    # Store job data
    await r.set(f"fleet:job:{job_id}", json.dumps(job_data), ex=86400 * 7)  # 7 day TTL

    # Add to appropriate priority queue
    queue_key = {
        JobPriority.HIGH: QUEUE_HIGH,
        JobPriority.NORMAL: QUEUE_NORMAL,
        JobPriority.LOW: QUEUE_LOW,
    }[job.priority]

    await r.rpush(queue_key, job_id)

    # Increment queue counter
    await r.incr("fleet:stats:jobs_queued")

    return {"job_id": job_id, "status": "queued", "queue": job.priority.value}


@router.get("/jobs/{job_id}")
async def get_job(job_id: str):
    """Get job status and details."""
    data = await r.get(f"fleet:job:{job_id}")
    if not data:
        raise HTTPException(status_code=404, detail="Job not found")
    return json.loads(data)


@router.get("/jobs")
async def list_jobs(
    status: Optional[str] = None,
    job_type: Optional[str] = None,
    limit: int = 50,
    offset: int = 0
):
    """List jobs with optional filtering."""
    # Get all job keys (in production, use scan for large datasets)
    keys = await r.keys("fleet:job:*")

    jobs = []
    for key in keys:
        data = await r.get(key)
        if data:
            job = json.loads(data)
            # Apply filters
            if status and job.get("status") != status:
                continue
            if job_type and job.get("job_type") != job_type:
                continue
            jobs.append(job)

    # Sort by created_at descending
    jobs.sort(key=lambda x: x.get("created_at", ""), reverse=True)

    # Apply pagination
    return {
        "jobs": jobs[offset:offset + limit],
        "total": len(jobs),
        "limit": limit,
        "offset": offset
    }


@router.delete("/jobs/{job_id}")
async def cancel_job(job_id: str):
    """Cancel a queued or processing job."""
    data = await r.get(f"fleet:job:{job_id}")
    if not data:
        raise HTTPException(status_code=404, detail="Job not found")

    job = json.loads(data)
    if job["status"] in [JobStatus.COMPLETED.value, JobStatus.FAILED.value]:
        raise HTTPException(status_code=400, detail="Cannot cancel completed/failed job")

    # Update status
    job["status"] = JobStatus.CANCELLED.value
    job["completed_at"] = datetime.utcnow().isoformat()
    await r.set(f"fleet:job:{job_id}", json.dumps(job))

    # Remove from queue if queued
    for queue in [QUEUE_HIGH, QUEUE_NORMAL, QUEUE_LOW]:
        await r.lrem(queue, 0, job_id)

    # Remove from processing
    await r.srem(QUEUE_PROCESSING, job_id)

    return {"job_id": job_id, "status": "cancelled"}


@router.post("/jobs/{job_id}/retry")
async def retry_job(job_id: str):
    """Retry a failed job."""
    data = await r.get(f"fleet:job:{job_id}")
    if not data:
        raise HTTPException(status_code=404, detail="Job not found")

    job = json.loads(data)
    if job["status"] not in [JobStatus.FAILED.value, JobStatus.DEAD.value]:
        raise HTTPException(status_code=400, detail="Can only retry failed jobs")

    # Reset job state
    job["status"] = JobStatus.QUEUED.value
    job["error"] = None
    job["started_at"] = None
    job["completed_at"] = None
    job["assigned_node"] = None
    job["progress"] = 0.0
    await r.set(f"fleet:job:{job_id}", json.dumps(job))

    # Add back to queue
    queue_key = {
        "high": QUEUE_HIGH,
        "normal": QUEUE_NORMAL,
        "low": QUEUE_LOW,
    }.get(job["priority"], QUEUE_NORMAL)

    await r.rpush(queue_key, job_id)

    return {"job_id": job_id, "status": "requeued"}


# ============== Queue Statistics ==============

@router.get("/stats")
async def get_queue_stats():
    """Get queue statistics and health metrics."""
    # Queue depths
    high_depth = await r.llen(QUEUE_HIGH)
    normal_depth = await r.llen(QUEUE_NORMAL)
    low_depth = await r.llen(QUEUE_LOW)
    processing = await r.scard(QUEUE_PROCESSING)

    # Historical stats
    jobs_queued = int(await r.get("fleet:stats:jobs_queued") or 0)
    jobs_completed = int(await r.get("fleet:stats:jobs_completed") or 0)
    jobs_failed = int(await r.get("fleet:stats:jobs_failed") or 0)

    # Get active nodes
    node_ids = await r.smembers("nodes:active")
    active_nodes = 0
    computing_nodes = 0
    total_gpu_util = 0

    for nid in node_ids:
        data = await r.get(f"node:{nid}:heartbeat")
        if data:
            node = json.loads(data)
            active_nodes += 1
            activity = node.get("activity") or {}
            if activity.get("status") == "computing":
                computing_nodes += 1
            gpu = node.get("gpu") or {}
            total_gpu_util += gpu.get("utilization", 0)

    avg_gpu_util = total_gpu_util / active_nodes if active_nodes > 0 else 0

    # Processing rate (jobs/minute over last 5 minutes)
    rate_key = "fleet:stats:processing_rate"
    rate_data = await r.get(rate_key)
    processing_rate = json.loads(rate_data) if rate_data else {"rate": 0, "window": 300}

    return {
        "queues": {
            "high": high_depth,
            "normal": normal_depth,
            "low": low_depth,
            "total": high_depth + normal_depth + low_depth,
        },
        "processing": processing,
        "totals": {
            "queued": jobs_queued,
            "completed": jobs_completed,
            "failed": jobs_failed,
        },
        "nodes": {
            "active": active_nodes,
            "computing": computing_nodes,
            "avg_gpu_utilization": round(avg_gpu_util, 1),
        },
        "processing_rate": processing_rate,
        "health": "healthy" if active_nodes > 0 and (high_depth + normal_depth) < 100 else "degraded",
    }


# ============== Worker Operations ==============

@router.post("/claim")
async def claim_job(node_id: str, job_types: Optional[List[str]] = None):
    """
    Worker endpoint: Claim the next available job from the queue.
    Priority order: HIGH -> NORMAL -> LOW
    """
    # Verify node is active
    node_data = await r.get(f"node:{node_id}:heartbeat")
    if not node_data:
        raise HTTPException(status_code=403, detail="Node not registered")

    node = json.loads(node_data)
    node_cluster = get_node_cluster(node_id)

    # Try each queue in priority order
    for queue in [QUEUE_HIGH, QUEUE_NORMAL, QUEUE_LOW]:
        # Atomically pop from queue
        job_id = await r.lpop(queue)
        if not job_id:
            continue

        # Get job data
        job_data = await r.get(f"fleet:job:{job_id}")
        if not job_data:
            continue

        job = json.loads(job_data)

        # Check if job is targeted to specific node/cluster
        if job.get("target_node") and job["target_node"] != node_id:
            # Put back in queue and try next
            await r.lpush(queue, job_id)
            continue

        if job.get("target_cluster") and job["target_cluster"] != node_cluster:
            # Put back in queue and try next
            await r.lpush(queue, job_id)
            continue

        # Check job type filter
        if job_types and job["job_type"] not in job_types:
            await r.lpush(queue, job_id)
            continue

        # Claim the job
        job["status"] = JobStatus.PROCESSING.value
        job["started_at"] = datetime.utcnow().isoformat()
        job["assigned_node"] = node_id
        await r.set(f"fleet:job:{job_id}", json.dumps(job))

        # Add to processing set
        await r.sadd(QUEUE_PROCESSING, job_id)

        return job

    # No jobs available
    return None


@router.post("/complete/{job_id}")
async def complete_job(
    job_id: str,
    node_id: str,
    result: Optional[Dict[str, Any]] = None,
    error: Optional[str] = None
):
    """Worker endpoint: Mark a job as completed or failed."""
    data = await r.get(f"fleet:job:{job_id}")
    if not data:
        raise HTTPException(status_code=404, detail="Job not found")

    job = json.loads(data)

    if job.get("assigned_node") != node_id:
        raise HTTPException(status_code=403, detail="Job not assigned to this node")

    now = datetime.utcnow().isoformat()

    if error:
        job["retry_count"] = job.get("retry_count", 0) + 1
        if job["retry_count"] >= job.get("max_retries", 3):
            job["status"] = JobStatus.DEAD.value
            await r.incr("fleet:stats:jobs_failed")
        else:
            # Requeue for retry
            job["status"] = JobStatus.QUEUED.value
            job["assigned_node"] = None
            job["started_at"] = None
            queue_key = {
                "high": QUEUE_HIGH,
                "normal": QUEUE_NORMAL,
                "low": QUEUE_LOW,
            }.get(job["priority"], QUEUE_NORMAL)
            await r.rpush(queue_key, job_id)
        job["error"] = error
    else:
        job["status"] = JobStatus.COMPLETED.value
        job["result"] = result
        job["progress"] = 100.0
        await r.incr("fleet:stats:jobs_completed")

    job["completed_at"] = now
    await r.set(f"fleet:job:{job_id}", json.dumps(job))

    # Remove from processing set
    await r.srem(QUEUE_PROCESSING, job_id)

    # Update processing rate
    await update_processing_rate()

    # Send callback if configured
    if job.get("callback_url") and job["status"] == JobStatus.COMPLETED.value:
        # Fire and forget callback
        asyncio.create_task(send_callback(job))

    return {"job_id": job_id, "status": job["status"]}


@router.post("/progress/{job_id}")
async def update_progress(job_id: str, node_id: str, progress: float, detail: Optional[str] = None):
    """Worker endpoint: Update job progress."""
    data = await r.get(f"fleet:job:{job_id}")
    if not data:
        raise HTTPException(status_code=404, detail="Job not found")

    job = json.loads(data)
    if job.get("assigned_node") != node_id:
        raise HTTPException(status_code=403, detail="Job not assigned to this node")

    job["progress"] = min(max(progress, 0), 100)
    if detail:
        job["progress_detail"] = detail

    await r.set(f"fleet:job:{job_id}", json.dumps(job))
    return {"job_id": job_id, "progress": job["progress"]}


# ============== Auto-Scaling ==============

@router.get("/scaling/config")
async def get_scaling_config():
    """Get auto-scaling configuration."""
    data = await r.get(SCALING_CONFIG)
    if data:
        return json.loads(data)
    return ScalingConfig().model_dump()


@router.put("/scaling/config")
async def update_scaling_config(config: ScalingConfig):
    """Update auto-scaling configuration."""
    await r.set(SCALING_CONFIG, json.dumps(config.model_dump()))
    return config


@router.get("/scaling/state")
async def get_scaling_state():
    """Get current auto-scaling state."""
    data = await r.get(SCALING_STATE)
    if data:
        return json.loads(data)
    return {
        "last_scale_action": None,
        "last_scale_time": None,
        "current_scale": 0,
        "recommended_scale": 0,
        "reason": None,
    }


@router.post("/scaling/evaluate")
async def evaluate_scaling():
    """
    Evaluate scaling needs and return recommendation.
    This can be called by a scheduler or manually.
    """
    # Get config
    config_data = await r.get(SCALING_CONFIG)
    config = ScalingConfig(**json.loads(config_data)) if config_data else ScalingConfig()

    if not config.enabled:
        return {"action": "none", "reason": "Auto-scaling disabled"}

    # Get current state
    state_data = await r.get(SCALING_STATE)
    state = json.loads(state_data) if state_data else {}

    # Check cooldown
    last_scale_time = state.get("last_scale_time")
    if last_scale_time:
        cooldown_end = datetime.fromisoformat(last_scale_time) + timedelta(seconds=config.cooldown_seconds)
        if datetime.utcnow() < cooldown_end:
            return {"action": "none", "reason": "In cooldown period"}

    # Get queue stats
    stats = await get_queue_stats()
    queue_depth = stats["queues"]["total"]
    active_nodes = stats["nodes"]["active"]
    avg_gpu_util = stats["nodes"]["avg_gpu_utilization"]

    action = "none"
    reason = None
    recommended = active_nodes

    # Scale up conditions
    if queue_depth > config.target_queue_depth and active_nodes < config.max_nodes:
        if avg_gpu_util > config.scale_up_threshold * 100:
            action = "scale_up"
            recommended = min(active_nodes + 1, config.max_nodes)
            reason = f"Queue depth ({queue_depth}) exceeds target ({config.target_queue_depth}) and GPU util ({avg_gpu_util:.1f}%) high"

    # Scale down conditions
    elif queue_depth < config.target_queue_depth // 2 and active_nodes > config.min_nodes:
        if avg_gpu_util < config.scale_down_threshold * 100:
            action = "scale_down"
            recommended = max(active_nodes - 1, config.min_nodes)
            reason = f"Queue depth ({queue_depth}) low and GPU util ({avg_gpu_util:.1f}%) below threshold"

    # Update state
    new_state = {
        "last_evaluation": datetime.utcnow().isoformat(),
        "current_scale": active_nodes,
        "recommended_scale": recommended,
        "queue_depth": queue_depth,
        "avg_gpu_utilization": avg_gpu_util,
        "action": action,
        "reason": reason,
    }

    if action != "none":
        new_state["last_scale_action"] = action
        new_state["last_scale_time"] = datetime.utcnow().isoformat()

    await r.set(SCALING_STATE, json.dumps(new_state))

    return new_state


# ============== Helper Functions ==============

def get_node_cluster(node_id: str) -> str:
    """Determine cluster based on node ID."""
    id_lower = node_id.lower()
    if "spark" in id_lower or "dgx" in id_lower:
        return "spark"

    import re
    match = re.match(r'agx-?(\d+)', id_lower)
    if match:
        num = int(match.group(1))
        if num <= 2:
            return "vision"
        elif num <= 4:
            return "media-gen"
        elif num <= 6:
            return "media-proc"
        elif num <= 9:
            return "llm"
        elif num == 10:
            return "voice"
        elif num == 11:
            return "music"
        else:
            return "roamer"
    return "default"


async def update_processing_rate():
    """Update the rolling processing rate."""
    now = datetime.utcnow()
    rate_key = "fleet:stats:processing_rate"
    history_key = "fleet:stats:completion_history"

    # Add completion timestamp to history
    await r.lpush(history_key, now.isoformat())
    await r.ltrim(history_key, 0, 299)  # Keep last 300 completions

    # Calculate rate over last 5 minutes
    window_start = now - timedelta(seconds=300)
    history = await r.lrange(history_key, 0, -1)

    completions_in_window = sum(
        1 for ts in history
        if datetime.fromisoformat(ts) > window_start
    )

    rate = completions_in_window / 5.0  # jobs per minute

    await r.set(rate_key, json.dumps({
        "rate": round(rate, 2),
        "window": 300,
        "completions": completions_in_window,
        "updated": now.isoformat(),
    }))


async def send_callback(job: Dict[str, Any]):
    """Send completion callback to configured URL."""
    import aiohttp

    callback_url = job.get("callback_url")
    if not callback_url:
        return

    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(
                callback_url,
                json={
                    "job_id": job["job_id"],
                    "status": job["status"],
                    "result": job.get("result"),
                    "completed_at": job.get("completed_at"),
                },
                timeout=aiohttp.ClientTimeout(total=10)
            ) as resp:
                print(f"Callback sent to {callback_url}: {resp.status}")
    except Exception as e:
        print(f"Callback failed for {callback_url}: {e}")


# ============== Batch Operations ==============

@router.post("/jobs/batch")
async def create_batch_jobs(jobs: List[JobCreate]):
    """Create multiple jobs in a batch."""
    results = []
    for job in jobs:
        result = await create_job(job, BackgroundTasks())
        results.append(result)
    return {"created": len(results), "jobs": results}


@router.delete("/jobs/batch")
async def cancel_batch_jobs(job_ids: List[str]):
    """Cancel multiple jobs."""
    results = []
    for job_id in job_ids:
        try:
            result = await cancel_job(job_id)
            results.append(result)
        except HTTPException:
            results.append({"job_id": job_id, "error": "not found or cannot cancel"})
    return {"processed": len(results), "results": results}


@router.post("/purge")
async def purge_completed_jobs(older_than_hours: int = 24):
    """Purge completed/failed jobs older than specified hours."""
    cutoff = datetime.utcnow() - timedelta(hours=older_than_hours)
    keys = await r.keys("fleet:job:*")

    purged = 0
    for key in keys:
        data = await r.get(key)
        if data:
            job = json.loads(data)
            if job["status"] in [JobStatus.COMPLETED.value, JobStatus.FAILED.value, JobStatus.DEAD.value]:
                completed_at = job.get("completed_at")
                if completed_at and datetime.fromisoformat(completed_at) < cutoff:
                    await r.delete(key)
                    purged += 1

    return {"purged": purged}
