"""
Install Queue API - Manages parallel installation of Fleet Agent on multiple nodes.
"""
import asyncio
import json
import uuid
from datetime import datetime
from fastapi import APIRouter, HTTPException, BackgroundTasks
from pydantic import BaseModel
from typing import List, Optional, Dict
import redis.asyncio as redis
from config import settings

router = APIRouter()
r = redis.from_url(settings.REDIS_URL, decode_responses=True)

# Maximum parallel installs
MAX_PARALLEL_INSTALLS = 3


class InstallRequest(BaseModel):
    ip: str
    hostname: Optional[str] = None
    credential_id: str
    node_alias: Optional[str] = None


class QueueInstallRequest(BaseModel):
    nodes: List[InstallRequest]


class InstallJob:
    """Represents a single install job."""
    def __init__(self, ip: str, hostname: str, credential_id: str, node_alias: str = None):
        self.id = str(uuid.uuid4())[:8]
        self.ip = ip
        self.hostname = hostname
        self.credential_id = credential_id
        self.node_alias = node_alias or f"node-{ip.split('.')[-1]}"
        self.status = "queued"  # queued, running, completed, failed
        self.progress = 0
        self.logs = []
        self.started_at = None
        self.completed_at = None
        self.error = None

    def to_dict(self):
        return {
            "id": self.id,
            "ip": self.ip,
            "hostname": self.hostname,
            "node_alias": self.node_alias,
            "status": self.status,
            "progress": self.progress,
            "logs": self.logs,
            "started_at": self.started_at,
            "completed_at": self.completed_at,
            "error": self.error
        }


# Store for active install queue
install_queue: Dict[str, InstallJob] = {}
queue_lock = asyncio.Lock()


async def save_queue_state():
    """Save queue state to Redis for persistence."""
    state = {job_id: job.to_dict() for job_id, job in install_queue.items()}
    await r.set("install:queue:state", json.dumps(state), ex=3600)


async def run_install(job: InstallJob):
    """Run the actual installation for a single node."""
    import asyncssh
    from api.vault import get_credential

    job.status = "running"
    job.started_at = datetime.now().isoformat()
    job.logs.append(f"[{datetime.now().strftime('%H:%M:%S')}] Starting installation on {job.ip}...")
    await save_queue_state()

    try:
        # Get credential
        cred = await get_credential(job.credential_id)
        if not cred:
            raise Exception("Credential not found")

        job.logs.append(f"[{datetime.now().strftime('%H:%M:%S')}] Connecting via SSH...")
        job.progress = 10
        await save_queue_state()

        # Connect via SSH
        async with asyncssh.connect(
            host=job.ip,
            username=cred['username'],
            password=cred['password'],
            known_hosts=None,
            connect_timeout=30
        ) as conn:
            job.logs.append(f"[{datetime.now().strftime('%H:%M:%S')}] Connected! Downloading bootstrap script...")
            job.progress = 20
            await save_queue_state()

            # Download and run bootstrap script
            spark_ip = "192.168.1.214"
            bootstrap_cmd = f"""
echo '{cred['password']}' | sudo -S bash -c '
    cd /tmp
    curl -sO http://{spark_ip}:8765/install/bootstrap-node.sh
    chmod +x bootstrap-node.sh
    ./bootstrap-node.sh {spark_ip} {job.node_alias}
'
"""
            job.logs.append(f"[{datetime.now().strftime('%H:%M:%S')}] Running bootstrap script (this takes a few minutes)...")
            job.progress = 30
            await save_queue_state()

            # Run with streaming output
            result = await conn.run(bootstrap_cmd, timeout=600)

            # Add output to logs (truncated)
            output_lines = result.stdout.split('\n')
            for i, line in enumerate(output_lines[-20:]):  # Last 20 lines
                if line.strip():
                    job.logs.append(line.strip())

            # Check for success:
            # 1. Exit status 0 = success
            # 2. "Bootstrap Complete" in stdout = success (reboot may kill connection before exit)
            # 3. Exit status None with completion message = success (reboot killed connection)
            bootstrap_complete = "Bootstrap Complete" in result.stdout

            if result.exit_status == 0 or bootstrap_complete:
                job.status = "completed"
                job.progress = 100
                job.logs.append(f"[{datetime.now().strftime('%H:%M:%S')}] Installation completed successfully! Node is rebooting...")
            else:
                job.status = "failed"
                job.error = f"Exit code: {result.exit_status}"
                job.logs.append(f"[{datetime.now().strftime('%H:%M:%S')}] Installation failed: {result.stderr[:500] if result.stderr else 'No error output'}")

    except asyncio.TimeoutError:
        job.status = "failed"
        job.error = "Connection timeout"
        job.logs.append(f"[{datetime.now().strftime('%H:%M:%S')}] ERROR: Connection timeout")
    except Exception as e:
        error_str = str(e).lower()
        # Check if this is a connection closed due to reboot (expected behavior)
        if "connection" in error_str and ("closed" in error_str or "reset" in error_str or "lost" in error_str):
            # Check if we had progress - if bootstrap was running, likely a reboot
            if job.progress >= 30:
                job.status = "completed"
                job.progress = 100
                job.logs.append(f"[{datetime.now().strftime('%H:%M:%S')}] Connection closed (node is rebooting). Installation likely successful.")
            else:
                job.status = "failed"
                job.error = str(e)
                job.logs.append(f"[{datetime.now().strftime('%H:%M:%S')}] ERROR: {str(e)}")
        else:
            job.status = "failed"
            job.error = str(e)
            job.logs.append(f"[{datetime.now().strftime('%H:%M:%S')}] ERROR: {str(e)}")

    job.completed_at = datetime.now().isoformat()
    await save_queue_state()


async def process_queue():
    """Process the install queue with parallel workers."""
    while True:
        async with queue_lock:
            # Find queued jobs
            queued_jobs = [j for j in install_queue.values() if j.status == "queued"]
            running_jobs = [j for j in install_queue.values() if j.status == "running"]

            # Start new jobs if under limit
            slots_available = MAX_PARALLEL_INSTALLS - len(running_jobs)
            jobs_to_start = queued_jobs[:slots_available]

            for job in jobs_to_start:
                asyncio.create_task(run_install(job))

        # Check every 2 seconds
        await asyncio.sleep(2)

        # Stop if queue is empty and no running jobs
        async with queue_lock:
            active = [j for j in install_queue.values() if j.status in ("queued", "running")]
            if not active:
                break


@router.post("/queue")
async def queue_installs(request: QueueInstallRequest, background_tasks: BackgroundTasks):
    """Queue multiple nodes for installation."""
    global install_queue

    jobs = []
    for node in request.nodes:
        job = InstallJob(
            ip=node.ip,
            hostname=node.hostname or node.ip,
            credential_id=node.credential_id,
            node_alias=node.node_alias
        )
        install_queue[job.id] = job
        jobs.append(job.to_dict())

    await save_queue_state()

    # Start queue processor in background
    background_tasks.add_task(process_queue)

    return {
        "message": f"Queued {len(jobs)} nodes for installation",
        "jobs": jobs,
        "max_parallel": MAX_PARALLEL_INSTALLS
    }


@router.get("/queue")
async def get_queue_status():
    """Get current queue status."""
    return {
        "jobs": [job.to_dict() for job in install_queue.values()],
        "summary": {
            "total": len(install_queue),
            "queued": sum(1 for j in install_queue.values() if j.status == "queued"),
            "running": sum(1 for j in install_queue.values() if j.status == "running"),
            "completed": sum(1 for j in install_queue.values() if j.status == "completed"),
            "failed": sum(1 for j in install_queue.values() if j.status == "failed"),
        },
        "max_parallel": MAX_PARALLEL_INSTALLS
    }


@router.get("/queue/{job_id}")
async def get_job_status(job_id: str):
    """Get status of a specific job."""
    if job_id not in install_queue:
        raise HTTPException(status_code=404, detail="Job not found")
    return install_queue[job_id].to_dict()


@router.delete("/queue/{job_id}")
async def cancel_job(job_id: str):
    """Cancel a queued job (can't cancel running jobs)."""
    if job_id not in install_queue:
        raise HTTPException(status_code=404, detail="Job not found")

    job = install_queue[job_id]
    if job.status == "running":
        raise HTTPException(status_code=400, detail="Cannot cancel running job")

    del install_queue[job_id]
    await save_queue_state()
    return {"message": "Job cancelled"}


@router.delete("/queue")
async def clear_queue():
    """Clear all completed/failed jobs from queue."""
    global install_queue
    async with queue_lock:
        install_queue = {
            job_id: job for job_id, job in install_queue.items()
            if job.status in ("queued", "running")
        }
    await save_queue_state()
    return {"message": "Queue cleared"}


@router.post("/queue/{job_id}/retry")
async def retry_job(job_id: str, background_tasks: BackgroundTasks):
    """Retry a failed job."""
    if job_id not in install_queue:
        raise HTTPException(status_code=404, detail="Job not found")

    job = install_queue[job_id]
    if job.status not in ("failed", "completed"):
        raise HTTPException(status_code=400, detail="Can only retry failed or completed jobs")

    # Reset job state
    job.status = "queued"
    job.progress = 0
    job.logs = [f"[{datetime.now().strftime('%H:%M:%S')}] Queued for retry..."]
    job.started_at = None
    job.completed_at = None
    job.error = None

    await save_queue_state()

    # Start queue processor
    background_tasks.add_task(process_queue)

    return {"message": "Job queued for retry", "job": job.to_dict()}


@router.post("/queue/retry-failed")
async def retry_all_failed(background_tasks: BackgroundTasks):
    """Retry all failed jobs."""
    retried = []
    async with queue_lock:
        for job in install_queue.values():
            if job.status == "failed":
                job.status = "queued"
                job.progress = 0
                job.logs = [f"[{datetime.now().strftime('%H:%M:%S')}] Queued for retry..."]
                job.started_at = None
                job.completed_at = None
                job.error = None
                retried.append(job.id)

    if retried:
        await save_queue_state()
        background_tasks.add_task(process_queue)

    return {"message": f"Retried {len(retried)} failed jobs", "retried": retried}


class QuickFixRequest(BaseModel):
    ip: str
    credential_id: str
    node_alias: str


@router.post("/quick-fix")
async def quick_fix_node(request: QuickFixRequest):
    """Quick fix for existing nodes - creates config file and restarts agent.

    This is for nodes that were installed before the config file was added.
    It's faster than a full reinstall.
    """
    import asyncssh
    from api.vault import get_credential

    try:
        cred = await get_credential(request.credential_id)
        if not cred:
            raise HTTPException(status_code=404, detail="Credential not found")

        spark_ip = "192.168.1.214"

        async with asyncssh.connect(
            host=request.ip,
            username=cred['username'],
            password=cred['password'],
            known_hosts=None,
            connect_timeout=30
        ) as conn:
            # Create config file with proper node_id
            fix_cmd = f"""
echo '{cred['password']}' | sudo -S bash -c '
    mkdir -p /opt/fleet-commander
    cat > /opt/fleet-commander/config.json << EOF
{{
  "node_id": "{request.node_alias}",
  "spark_ip": "{spark_ip}",
  "spark_api": "http://{spark_ip}:8765",
  "installed_at": "$(date -Iseconds)"
}}
EOF
    systemctl restart fleet-agent
    echo "Config created for {request.node_alias}, agent restarted"
'
"""
            result = await conn.run(fix_cmd, timeout=30)

            if result.exit_status == 0:
                return {
                    "status": "success",
                    "message": f"Node {request.node_alias} fixed successfully",
                    "output": result.stdout
                }
            else:
                raise HTTPException(
                    status_code=500,
                    detail=f"Fix failed: {result.stderr}"
                )
    except asyncssh.Error as e:
        raise HTTPException(status_code=500, detail=f"SSH error: {str(e)}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


class BatchQuickFixRequest(BaseModel):
    nodes: List[InstallRequest]


@router.post("/quick-fix/batch")
async def batch_quick_fix(request: BatchQuickFixRequest, background_tasks: BackgroundTasks):
    """Batch quick fix for multiple existing nodes."""
    global install_queue

    jobs = []
    for node in request.nodes:
        job = InstallJob(
            ip=node.ip,
            hostname=node.hostname or node.ip,
            credential_id=node.credential_id,
            node_alias=node.node_alias
        )
        job.quick_fix = True  # Mark as quick fix job
        install_queue[job.id] = job
        jobs.append(job.to_dict())

    await save_queue_state()
    background_tasks.add_task(process_quick_fix_queue)

    return {
        "message": f"Queued {len(jobs)} nodes for quick fix",
        "jobs": jobs,
        "max_parallel": MAX_PARALLEL_INSTALLS
    }


async def run_quick_fix(job: InstallJob):
    """Run quick fix for a single node."""
    import asyncssh
    from api.vault import get_credential

    job.status = "running"
    job.started_at = datetime.now().isoformat()
    job.logs.append(f"[{datetime.now().strftime('%H:%M:%S')}] Starting quick fix on {job.ip}...")
    await save_queue_state()

    try:
        cred = await get_credential(job.credential_id)
        if not cred:
            raise Exception("Credential not found")

        job.logs.append(f"[{datetime.now().strftime('%H:%M:%S')}] Connecting via SSH...")
        job.progress = 30
        await save_queue_state()

        spark_ip = "192.168.1.214"

        async with asyncssh.connect(
            host=job.ip,
            username=cred['username'],
            password=cred['password'],
            known_hosts=None,
            connect_timeout=30
        ) as conn:
            job.logs.append(f"[{datetime.now().strftime('%H:%M:%S')}] Creating config file...")
            job.progress = 50
            await save_queue_state()

            fix_cmd = f"""
echo '{cred['password']}' | sudo -S bash -c '
    mkdir -p /opt/fleet-commander/agent

    # Create config file
    cat > /opt/fleet-commander/config.json << EOF
{{
  "node_id": "{job.node_alias}",
  "spark_ip": "{spark_ip}",
  "spark_api": "http://{spark_ip}:8765",
  "installed_at": "$(date -Iseconds)"
}}
EOF

    # Download updated agent
    curl -s http://{spark_ip}:8765/install/fleet-agent/agent.py -o /opt/fleet-commander/agent/agent.py

    # Restart agent
    systemctl restart fleet-agent
    echo "SUCCESS"
'
"""
            result = await conn.run(fix_cmd, timeout=30)

            if "SUCCESS" in result.stdout:
                job.status = "completed"
                job.progress = 100
                job.logs.append(f"[{datetime.now().strftime('%H:%M:%S')}] Quick fix completed! Node will report as {job.node_alias}")
            else:
                job.status = "failed"
                job.error = result.stderr or "Unknown error"
                job.logs.append(f"[{datetime.now().strftime('%H:%M:%S')}] Quick fix failed: {result.stderr}")

    except Exception as e:
        job.status = "failed"
        job.error = str(e)
        job.logs.append(f"[{datetime.now().strftime('%H:%M:%S')}] ERROR: {str(e)}")

    job.completed_at = datetime.now().isoformat()
    await save_queue_state()


async def process_quick_fix_queue():
    """Process the quick fix queue with parallel workers."""
    while True:
        async with queue_lock:
            queued_jobs = [j for j in install_queue.values()
                          if j.status == "queued" and getattr(j, 'quick_fix', False)]
            running_jobs = [j for j in install_queue.values()
                           if j.status == "running" and getattr(j, 'quick_fix', False)]

            slots_available = MAX_PARALLEL_INSTALLS - len(running_jobs)
            jobs_to_start = queued_jobs[:slots_available]

            for job in jobs_to_start:
                asyncio.create_task(run_quick_fix(job))

        await asyncio.sleep(2)

        async with queue_lock:
            active = [j for j in install_queue.values()
                     if j.status in ("queued", "running") and getattr(j, 'quick_fix', False)]
            if not active:
                break
