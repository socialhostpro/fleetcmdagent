import asyncio
import asyncssh
from fastapi import APIRouter, HTTPException, BackgroundTasks
from pydantic import BaseModel
import redis.asyncio as redis
from config import settings
import json
import uuid

router = APIRouter()
r = redis.from_url(settings.REDIS_URL, decode_responses=True)

class InstallRequest(BaseModel):
    host: str
    credential_id: str
    spark_ip: str = "192.168.1.100"

# Success markers that indicate the bootstrap completed successfully
SUCCESS_MARKERS = [
    "Bootstrap Complete",
    "✨ Bootstrap Complete",
    "Rebooting in",
    "fleet-agent.service →",
    "Created symlink",
]

# Error markers that indicate a real failure
ERROR_MARKERS = [
    "FATAL:",
    "Installation aborted",
    "Critical error",
    "Permission denied (publickey",
]

def detect_status(logs: str, exit_status: int) -> str:
    """
    Detect the actual installation status based on log content.
    The bootstrap script reboots at the end, which causes SSH disconnection
    and non-zero exit codes even on success.
    """
    logs_lower = logs.lower()

    # Check for definite error markers first
    for marker in ERROR_MARKERS:
        if marker.lower() in logs_lower:
            return "failed"

    # Check for success markers
    success_count = sum(1 for marker in SUCCESS_MARKERS if marker.lower() in logs_lower)

    # If we see multiple success markers, it's a success even if exit code is non-zero
    if success_count >= 2:
        return "completed"

    # If exit code is 0, it's completed
    if exit_status == 0:
        return "completed"

    # If we got disconnected (common during reboot) but saw at least one success marker
    if success_count >= 1:
        return "completed"

    # Check for common harmless "errors" that don't indicate failure
    harmless_patterns = [
        "failed to stop",  # Service didn't exist before
        "unit file .* does not exist",  # First install
        "no mount point",  # Nothing to unmount
        "debconf:",  # Terminal warnings
        "cache has been disabled",  # pip cache warning
    ]

    # If the only "errors" are harmless ones, consider it success if we have any success marker
    if success_count >= 1:
        import re
        real_errors = False
        for line in logs.split('\n'):
            if 'error' in line.lower() or 'failed' in line.lower():
                # Check if it matches harmless patterns
                is_harmless = any(re.search(pattern, line.lower()) for pattern in harmless_patterns)
                if not is_harmless and 'Successfully' not in line:
                    real_errors = True
                    break

        if not real_errors:
            return "completed"

    return "failed"

async def run_install_task(task_id: str, host: str, cred: dict, install_cmd: str):
    all_logs = []
    exit_status = -1

    try:
        await r.hset(f"task:{task_id}", mapping={"status": "running", "log": "Connecting..."})

        async with asyncssh.connect(
            host,
            username=cred['username'],
            password=cred['password'],
            known_hosts=None,
            connect_timeout=30
        ) as conn:
            await r.hset(f"task:{task_id}", mapping={"log": "Connected. Starting installation script..."})
            await r.rpush(f"task:{task_id}:logs", f"Connected to {host}. Starting installation...\n")

            if cred['username'] != 'root':
                cmd = f"echo '{cred['password']}' | sudo -S bash -c '{install_cmd}'"
            else:
                cmd = f"bash -c '{install_cmd}'"

            try:
                # Run command and stream output
                async with conn.create_process(cmd, term_type='dumb') as process:
                    async for line in process.stdout:
                        all_logs.append(line)
                        await r.hset(f"task:{task_id}", mapping={"log": line})
                        await r.rpush(f"task:{task_id}:logs", line)

                    async for line in process.stderr:
                        all_logs.append(line)
                        await r.rpush(f"task:{task_id}:logs", line)

                    # Wait for process to complete
                    await process.wait()
                    exit_status = process.exit_status or 0

            except asyncssh.ConnectionLost:
                # Connection lost - likely due to reboot
                all_logs.append("\nConnection closed (node is likely rebooting)...\n")
                await r.rpush(f"task:{task_id}:logs", "\nConnection closed (node is likely rebooting)...\n")
                exit_status = -1  # Will be handled by detect_status
            except asyncssh.ProcessError as e:
                all_logs.append(f"\nProcess error: {e}\n")
                await r.rpush(f"task:{task_id}:logs", f"\nProcess error: {e}\n")
                exit_status = e.exit_status or 1

        # Determine final status based on logs content
        full_log = "".join(all_logs)
        final_status = detect_status(full_log, exit_status)

        await r.hset(f"task:{task_id}", mapping={"status": final_status})

        if final_status == "completed":
            await r.rpush(f"task:{task_id}:logs", "\n✅ Installation completed successfully! The node will appear in the dashboard after reboot.\n")
        else:
            await r.rpush(f"task:{task_id}:logs", f"\n❌ Installation may have failed. Exit code: {exit_status}\n")

    except asyncssh.PermissionDenied:
        await r.hset(f"task:{task_id}", mapping={"status": "error", "error": "Permission denied - check credentials"})
        await r.rpush(f"task:{task_id}:logs", "Error: Permission denied - check SSH credentials\n")
    except asyncssh.HostKeyNotVerifiable:
        await r.hset(f"task:{task_id}", mapping={"status": "error", "error": "Host key verification failed"})
        await r.rpush(f"task:{task_id}:logs", "Error: Host key verification failed\n")
    except asyncio.TimeoutError:
        await r.hset(f"task:{task_id}", mapping={"status": "error", "error": "Connection timeout"})
        await r.rpush(f"task:{task_id}:logs", "Error: Connection timeout\n")
    except Exception as e:
        error_msg = str(e)
        # Check if this is actually a success (connection dropped due to reboot)
        full_log = "".join(all_logs)
        if full_log and detect_status(full_log, -1) == "completed":
            await r.hset(f"task:{task_id}", mapping={"status": "completed"})
            await r.rpush(f"task:{task_id}:logs", "\n✅ Installation completed successfully! The node will appear in the dashboard after reboot.\n")
        else:
            await r.hset(f"task:{task_id}", mapping={"status": "error", "error": error_msg})
            await r.rpush(f"task:{task_id}:logs", f"Error: {error_msg}\n")

@router.post("/node")
async def install_node(req: InstallRequest, background_tasks: BackgroundTasks):
    # Fetch credential
    cred_json = await r.hget("vault:credentials", req.credential_id)
    if not cred_json:
        raise HTTPException(status_code=404, detail="Credential not found")

    cred = json.loads(cred_json)
    task_id = str(uuid.uuid4())

    # Build install command with node name from hostname if possible
    install_cmd = f"curl -s http://{req.spark_ip}:8765/install/bootstrap-node.sh | sudo bash -s -- {req.spark_ip}"

    # Initialize task
    await r.hset(f"task:{task_id}", mapping={"status": "pending", "host": req.host})

    # Start background task
    background_tasks.add_task(run_install_task, task_id, req.host, cred, install_cmd)

    return {"task_id": task_id, "status": "started"}

@router.get("/status/{task_id}")
async def get_task_status(task_id: str):
    task = await r.hgetall(f"task:{task_id}")
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    logs = await r.lrange(f"task:{task_id}:logs", 0, -1)
    return {
        "status": task.get("status"),
        "host": task.get("host"),
        "error": task.get("error"),
        "logs": "".join(logs)
    }

@router.delete("/task/{task_id}")
async def delete_task(task_id: str):
    """Clean up a completed task"""
    await r.delete(f"task:{task_id}")
    await r.delete(f"task:{task_id}:logs")
    return {"status": "deleted"}
