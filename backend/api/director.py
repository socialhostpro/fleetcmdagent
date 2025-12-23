"""
Director API - Hollywood-style Pipeline Orchestration

This is the "studio brain" that:
- Accepts workflow definitions from the UI
- Breaks them into tasks
- Distributes work across AGX nodes
- Tracks progress and handles QC loops

The goal: AGX nodes are workers, Spark is the boss.
"""
import asyncio
import json
import uuid
from datetime import datetime
from typing import List, Optional, Dict, Any
from fastapi import APIRouter, HTTPException, BackgroundTasks
from pydantic import BaseModel
import redis.asyncio as redis
from config import settings

router = APIRouter()
r = redis.from_url(settings.REDIS_URL, decode_responses=True)

# === Data Models ===

class WorkflowNode(BaseModel):
    id: str
    type: str  # input, segment, warp, render, qc, fix, output
    data: Dict[str, Any] = {}

class WorkflowEdge(BaseModel):
    source: str
    target: str

class Workflow(BaseModel):
    name: str
    nodes: List[WorkflowNode]
    edges: List[WorkflowEdge]

class ShotRequest(BaseModel):
    project_id: str
    sequence_id: str
    shot_id: str
    source_path: str  # s3://media-input/...
    workflow_id: Optional[str] = None
    motion_plan: Optional[Dict[str, Any]] = None  # Keyframes, paths, poses
    style_reference: Optional[str] = None
    quality_targets: Optional[Dict[str, float]] = None

class JobStatus(BaseModel):
    job_id: str
    workflow_name: str
    status: str  # queued, running, qc_check, fixing, completed, failed
    progress: float
    current_node: Optional[str] = None
    qc_scores: Optional[Dict[str, float]] = None
    retries: int = 0
    created_at: str
    updated_at: str

# === Workflow Management ===

@router.post("/workflow/run")
async def run_workflow(workflow: Workflow, background_tasks: BackgroundTasks):
    """Submit a workflow for execution across the AGX fleet."""
    job_id = str(uuid.uuid4())
    now = datetime.utcnow().isoformat()

    # Validate workflow has input and output
    node_types = {n.id: n.type for n in workflow.nodes}
    has_input = any(n.type == 'input' for n in workflow.nodes)
    has_output = any(n.type == 'output' for n in workflow.nodes)

    if not has_input or not has_output:
        raise HTTPException(status_code=400, detail="Workflow must have input and output nodes")

    # Build execution order (topological sort)
    execution_order = topological_sort(workflow)

    # Store job state (Redis requires all values to be strings/numbers, not None)
    job_state = {
        "job_id": job_id,
        "workflow_name": workflow.name,
        "workflow": workflow.model_dump_json(),
        "execution_order": json.dumps(execution_order),
        "status": "queued",
        "progress": 0,
        "current_node": "",
        "qc_scores": "{}",
        "retries": 0,
        "created_at": now,
        "updated_at": now,
    }

    await r.hset(f"job:{job_id}", mapping=job_state)
    await r.lpush("job:queue", job_id)

    # Start execution in background
    background_tasks.add_task(execute_workflow, job_id)

    return {"job_id": job_id, "status": "queued", "workflow_name": workflow.name}

@router.get("/workflow/jobs")
async def list_jobs(limit: int = 20):
    """List recent jobs."""
    # Get all job IDs from various states
    job_ids = await r.lrange("job:queue", 0, limit)
    running = await r.smembers("job:running")
    completed = await r.lrange("job:completed", 0, limit)

    jobs = []
    for jid in list(set(job_ids + list(running) + completed)):
        job = await r.hgetall(f"job:{jid}")
        if job:
            jobs.append({
                "job_id": job.get("job_id"),
                "workflow_name": job.get("workflow_name"),
                "status": job.get("status"),
                "progress": float(job.get("progress", 0)),
                "current_node": job.get("current_node"),
                "created_at": job.get("created_at"),
                "updated_at": job.get("updated_at"),
            })

    return sorted(jobs, key=lambda x: x.get("created_at", ""), reverse=True)[:limit]

@router.get("/workflow/job/{job_id}")
async def get_job(job_id: str):
    """Get job details."""
    job = await r.hgetall(f"job:{job_id}")
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    return {
        "job_id": job.get("job_id"),
        "workflow_name": job.get("workflow_name"),
        "status": job.get("status"),
        "progress": float(job.get("progress", 0)),
        "current_node": job.get("current_node"),
        "qc_scores": json.loads(job.get("qc_scores", "{}")),
        "retries": int(job.get("retries", 0)),
        "created_at": job.get("created_at"),
        "updated_at": job.get("updated_at"),
        "log": job.get("log", ""),
    }

@router.delete("/workflow/job/{job_id}")
async def cancel_job(job_id: str):
    """Cancel a running job."""
    job = await r.hgetall(f"job:{job_id}")
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    await r.hset(f"job:{job_id}", "status", "cancelled")
    await r.srem("job:running", job_id)

    return {"status": "cancelled", "job_id": job_id}

# === Shot Management (Hollywood-style) ===

@router.post("/shot/submit")
async def submit_shot(shot: ShotRequest, background_tasks: BackgroundTasks):
    """Submit a shot for processing through the pipeline."""
    shot_key = f"shot:{shot.project_id}:{shot.sequence_id}:{shot.shot_id}"
    job_id = str(uuid.uuid4())
    now = datetime.utcnow().isoformat()

    # Store shot metadata
    shot_data = {
        "job_id": job_id,
        "project_id": shot.project_id,
        "sequence_id": shot.sequence_id,
        "shot_id": shot.shot_id,
        "source_path": shot.source_path,
        "workflow_id": shot.workflow_id or "default",
        "motion_plan": json.dumps(shot.motion_plan or {}),
        "style_reference": shot.style_reference or "",
        "quality_targets": json.dumps(shot.quality_targets or {"stability": 0.8, "sharpness": 0.7}),
        "status": "queued",
        "qc_pass_count": 0,
        "created_at": now,
        "updated_at": now,
    }

    await r.hset(shot_key, mapping=shot_data)
    await r.lpush("shot:queue", shot_key)

    # Queue for processing
    background_tasks.add_task(process_shot, shot_key)

    return {
        "job_id": job_id,
        "shot_key": shot_key,
        "status": "queued",
    }

@router.get("/shot/{project_id}/{sequence_id}/{shot_id}")
async def get_shot(project_id: str, sequence_id: str, shot_id: str):
    """Get shot status and metadata."""
    shot_key = f"shot:{project_id}:{sequence_id}:{shot_id}"
    shot = await r.hgetall(shot_key)

    if not shot:
        raise HTTPException(status_code=404, detail="Shot not found")

    return {
        **shot,
        "motion_plan": json.loads(shot.get("motion_plan", "{}")),
        "quality_targets": json.loads(shot.get("quality_targets", "{}")),
        "qc_results": json.loads(shot.get("qc_results", "{}")),
    }

@router.get("/shots/{project_id}")
async def list_project_shots(project_id: str, sequence_id: Optional[str] = None):
    """List all shots for a project."""
    pattern = f"shot:{project_id}:{sequence_id or '*'}:*"
    keys = await r.keys(pattern)

    shots = []
    for key in keys:
        shot = await r.hgetall(key)
        if shot:
            shots.append({
                "shot_key": key,
                "shot_id": shot.get("shot_id"),
                "sequence_id": shot.get("sequence_id"),
                "status": shot.get("status"),
                "qc_pass_count": int(shot.get("qc_pass_count", 0)),
            })

    return sorted(shots, key=lambda x: (x.get("sequence_id", ""), x.get("shot_id", "")))

# === Node Assignment (Distribute to AGX Fleet) ===

@router.get("/nodes/available")
async def get_available_nodes():
    """Get AGX nodes available for work."""
    node_ids = await r.smembers("nodes:active")
    available = []

    for nid in node_ids:
        heartbeat = await r.get(f"node:{nid}:heartbeat")
        if heartbeat:
            data = json.loads(heartbeat)
            # Consider available if CPU < 80% and not already assigned
            if data.get("cpu", 100) < 80:
                assigned = await r.get(f"node:{nid}:assigned")
                if not assigned:
                    available.append({
                        "node_id": nid,
                        "ip": data.get("ip"),
                        "cpu": data.get("cpu"),
                        "gpu": data.get("gpu", {}).get("utilization", 0),
                        "memory": data.get("memory", {}).get("percent", 0),
                    })

    # Sort by GPU utilization (prefer less loaded nodes)
    return sorted(available, key=lambda x: x.get("gpu", 100))

@router.post("/nodes/{node_id}/assign")
async def assign_work(node_id: str, task: Dict[str, Any]):
    """Assign a task to a specific AGX node."""
    # Mark node as assigned
    await r.set(f"node:{node_id}:assigned", json.dumps(task), ex=3600)  # 1 hour TTL

    # Queue task for the node
    await r.lpush(f"node:{node_id}:tasks", json.dumps(task))

    return {"status": "assigned", "node_id": node_id, "task": task}

# === Internal Functions ===

def topological_sort(workflow: Workflow) -> List[str]:
    """Sort nodes in execution order based on edges."""
    # Build adjacency list
    graph = {n.id: [] for n in workflow.nodes}
    in_degree = {n.id: 0 for n in workflow.nodes}

    for edge in workflow.edges:
        graph[edge.source].append(edge.target)
        in_degree[edge.target] += 1

    # Start with nodes that have no dependencies (in_degree = 0)
    queue = [n for n in in_degree if in_degree[n] == 0]
    order = []

    while queue:
        node = queue.pop(0)
        order.append(node)

        for neighbor in graph[node]:
            in_degree[neighbor] -= 1
            if in_degree[neighbor] == 0:
                queue.append(neighbor)

    return order

async def execute_workflow(job_id: str):
    """Execute a workflow by processing nodes in order."""
    job = await r.hgetall(f"job:{job_id}")
    if not job:
        return

    workflow = json.loads(job.get("workflow", "{}"))
    execution_order = json.loads(job.get("execution_order", "[]"))
    nodes_by_id = {n["id"]: n for n in workflow.get("nodes", [])}

    await r.hset(f"job:{job_id}", "status", "running")
    await r.sadd("job:running", job_id)

    logs = []
    total_nodes = len(execution_order)

    try:
        for i, node_id in enumerate(execution_order):
            node = nodes_by_id.get(node_id, {})
            node_type = node.get("type", "unknown")

            # Update progress
            progress = (i / total_nodes) * 100
            await r.hset(f"job:{job_id}", mapping={
                "current_node": node_id,
                "progress": progress,
                "updated_at": datetime.utcnow().isoformat(),
            })

            logs.append(f"[{datetime.utcnow().isoformat()}] Processing node: {node_id} ({node_type})")

            # Simulate node processing (replace with actual implementations)
            if node_type == "input":
                logs.append(f"  Loading source media...")
                await asyncio.sleep(0.5)

            elif node_type == "segment":
                logs.append(f"  Running SAM segmentation...")
                # TODO: Dispatch to AGX node running SAM
                await asyncio.sleep(1)

            elif node_type == "warp":
                logs.append(f"  Computing motion warp...")
                await asyncio.sleep(0.5)

            elif node_type == "render":
                model = node.get("data", {}).get("model", "flux")
                quality = node.get("data", {}).get("quality", "preview")
                logs.append(f"  Rendering with {model} at {quality} quality...")
                # TODO: Dispatch to available AGX node
                await asyncio.sleep(2 if quality == "preview" else 5)

            elif node_type == "qc":
                logs.append(f"  Running QC checks...")
                # TODO: Implement actual QC scoring
                qc_scores = {"stability": 0.85, "sharpness": 0.78, "identity": 0.92}
                await r.hset(f"job:{job_id}", "qc_scores", json.dumps(qc_scores))
                logs.append(f"  QC Scores: {qc_scores}")
                await asyncio.sleep(1)

            elif node_type == "fix":
                actions = node.get("data", {}).get("actions", [])
                logs.append(f"  Applying fixes: {actions}")
                await asyncio.sleep(1)

            elif node_type == "output":
                logs.append(f"  Writing output to S3...")
                await asyncio.sleep(0.5)

            await r.hset(f"job:{job_id}", "log", "\n".join(logs))

        # Completed successfully
        await r.hset(f"job:{job_id}", mapping={
            "status": "completed",
            "progress": 100,
            "current_node": "",
            "updated_at": datetime.utcnow().isoformat(),
            "log": "\n".join(logs) + f"\n[{datetime.utcnow().isoformat()}] Workflow completed successfully!",
        })

    except Exception as e:
        logs.append(f"[{datetime.utcnow().isoformat()}] ERROR: {str(e)}")
        await r.hset(f"job:{job_id}", mapping={
            "status": "failed",
            "error": str(e),
            "log": "\n".join(logs),
            "updated_at": datetime.utcnow().isoformat(),
        })

    finally:
        await r.srem("job:running", job_id)
        await r.lpush("job:completed", job_id)

async def process_shot(shot_key: str):
    """Process a shot through the full pipeline."""
    shot = await r.hgetall(shot_key)
    if not shot:
        return

    await r.hset(shot_key, "status", "processing")

    # TODO: Implement full shot processing
    # 1. Load source
    # 2. Apply motion plan
    # 3. Render frames
    # 4. Run QC
    # 5. Apply fixes if needed
    # 6. Deliver to S3

    await asyncio.sleep(5)  # Placeholder

    await r.hset(shot_key, mapping={
        "status": "completed",
        "updated_at": datetime.utcnow().isoformat(),
    })
