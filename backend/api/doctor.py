"""
Fleet Doctor API - Control and monitor the autonomous AI healing system.
"""

from fastapi import APIRouter, HTTPException, BackgroundTasks
from pydantic import BaseModel
from typing import Optional, List, Dict, Any
from datetime import datetime
import json

router = APIRouter()


class DoctorConfigUpdate(BaseModel):
    """Configuration update request."""
    interval: Optional[int] = None
    auto_fix: Optional[bool] = None
    disk_threshold: Optional[int] = None
    disk_critical_threshold: Optional[int] = None
    memory_threshold: Optional[int] = None
    auto_fix_levels: Optional[List[str]] = None
    alert_levels: Optional[List[str]] = None
    cooldown_minutes: Optional[int] = None
    max_actions_per_hour: Optional[int] = None


class ManualActionRequest(BaseModel):
    """Request to manually execute an action."""
    action: str
    node_id: Optional[str] = None
    params: Optional[Dict[str, Any]] = None


# Lazy import to avoid circular imports
def get_doctor():
    """Get the Fleet Doctor instance."""
    from services.fleet_doctor import fleet_doctor
    if fleet_doctor is None:
        raise HTTPException(status_code=503, detail="Fleet Doctor not initialized")
    return fleet_doctor


@router.get("/status")
async def get_status():
    """
    Get current Fleet Doctor status.

    Returns running state, last check time, problem count, and configuration.
    """
    doctor = get_doctor()
    return await doctor.get_status()


@router.get("/problems")
async def get_problems():
    """
    Get current unresolved problems.

    Returns list of problems detected in the last check cycle.
    """
    doctor = get_doctor()
    problems = await doctor.get_problems()
    return {
        "count": len(problems),
        "problems": problems
    }


@router.get("/history")
async def get_history(limit: int = 50):
    """
    Get action history.

    Returns the last N actions taken by Fleet Doctor.
    """
    doctor = get_doctor()
    history = await doctor.get_history(limit)
    return {
        "count": len(history),
        "history": history
    }


@router.post("/start")
async def start_doctor(background_tasks: BackgroundTasks):
    """
    Start the Fleet Doctor monitoring loop.

    Begins continuous monitoring if not already running.
    """
    doctor = get_doctor()

    if doctor.running:
        return {"status": "already_running", "message": "Fleet Doctor is already running"}

    # Start in background
    import asyncio
    doctor.task = asyncio.create_task(doctor.run())

    return {
        "status": "started",
        "message": "Fleet Doctor started",
        "interval": doctor.config["interval"]
    }


@router.post("/stop")
async def stop_doctor():
    """
    Stop the Fleet Doctor monitoring loop.

    Stops monitoring but preserves state.
    """
    doctor = get_doctor()

    if not doctor.running:
        return {"status": "not_running", "message": "Fleet Doctor is not running"}

    doctor.stop()

    return {"status": "stopped", "message": "Fleet Doctor stopped"}


@router.post("/run-now")
async def run_now():
    """
    Trigger an immediate check cycle.

    Runs detection, diagnosis, and remediation without waiting for interval.
    """
    doctor = get_doctor()

    await doctor.run_once()

    status = await doctor.get_status()
    problems = await doctor.get_problems()

    return {
        "status": "completed",
        "message": "Check cycle completed",
        "problems_found": len(problems),
        "last_check": status.get("last_check")
    }


@router.post("/config")
async def update_config(config: DoctorConfigUpdate):
    """
    Update Fleet Doctor configuration.

    Updates thresholds, intervals, and auto-fix settings.
    """
    doctor = get_doctor()

    updates = config.model_dump(exclude_none=True)
    if not updates:
        raise HTTPException(status_code=400, detail="No configuration updates provided")

    await doctor.update_config(updates)

    return {
        "status": "updated",
        "config": doctor.config
    }


@router.get("/config")
async def get_config():
    """
    Get current Fleet Doctor configuration.
    """
    doctor = get_doctor()
    return {"config": doctor.config}


@router.post("/action")
async def execute_manual_action(request: ManualActionRequest):
    """
    Manually execute a remediation action.

    Bypasses AI diagnosis and directly executes the specified action.
    Use with caution.
    """
    doctor = get_doctor()

    if not doctor.action_executor:
        raise HTTPException(status_code=503, detail="Action executor not initialized")

    # Get credential for node if provided
    credential_id = None
    if request.node_id:
        credential_id = await doctor._get_node_credential(request.node_id)

    result = await doctor.action_executor.execute(
        action_name=request.action,
        node_id=request.node_id,
        params=request.params or {},
        credential_id=credential_id
    )

    return {
        "status": "completed",
        "result": result.to_dict()
    }


@router.get("/actions")
async def list_available_actions():
    """
    List all available remediation actions.

    Returns action definitions with descriptions and risk levels.
    """
    from services.doctor_actions import ACTIONS

    actions = []
    for name, info in ACTIONS.items():
        actions.append({
            "name": name,
            "description": info.get("description", ""),
            "risk_level": info.get("risk_level", "unknown"),
            "method": info.get("method", "POST"),
            "endpoint": info.get("endpoint", "N/A")
        })

    return {"actions": actions}


@router.get("/report")
async def get_daily_report(date: Optional[str] = None):
    """
    Get a summary report for a specific date.

    Args:
        date: Date in YYYY-MM-DD format. Defaults to today.
    """
    doctor = get_doctor()

    # Default to today
    if date is None:
        date = datetime.utcnow().strftime("%Y-%m-%d")

    # Get all history and filter by date
    history = await doctor.get_history(limit=100)

    day_history = [
        h for h in history
        if h.get("timestamp", "").startswith(date)
    ]

    # Calculate statistics
    total_actions = len(day_history)
    successful = sum(1 for h in day_history if h.get("result", {}).get("success"))
    failed = total_actions - successful

    # Count by problem type
    problem_types = {}
    for h in day_history:
        pt = h.get("problem", {}).get("type", "unknown")
        problem_types[pt] = problem_types.get(pt, 0) + 1

    # Count by action
    action_counts = {}
    for h in day_history:
        action = h.get("result", {}).get("action", "unknown")
        action_counts[action] = action_counts.get(action, 0) + 1

    return {
        "date": date,
        "summary": {
            "total_actions": total_actions,
            "successful": successful,
            "failed": failed,
            "success_rate": f"{(successful / total_actions * 100):.1f}%" if total_actions > 0 else "N/A"
        },
        "by_problem_type": problem_types,
        "by_action": action_counts,
        "details": day_history
    }


@router.delete("/problems/{problem_id}")
async def dismiss_problem(problem_id: str):
    """
    Dismiss a problem without taking action.

    Removes the problem from the active list. Use for false positives.
    """
    doctor = get_doctor()

    if not doctor.redis_client:
        raise HTTPException(status_code=503, detail="Redis not connected")

    # Remove from problems hash
    deleted = await doctor.redis_client.hdel("fleet:doctor:problems", problem_id)

    if deleted:
        await doctor._publish_event("problem_dismissed", {"problem_id": problem_id})
        return {"status": "dismissed", "problem_id": problem_id}
    else:
        raise HTTPException(status_code=404, detail="Problem not found")


@router.get("/stats")
async def get_stats():
    """
    Get Fleet Doctor statistics.

    Returns overall performance metrics.
    """
    doctor = get_doctor()

    # Get all history
    history = await doctor.get_history(limit=100)

    # Calculate stats
    total = len(history)
    successful = sum(1 for h in history if h.get("result", {}).get("success"))

    # Time-based stats
    from datetime import timedelta
    now = datetime.utcnow()

    last_hour = [
        h for h in history
        if datetime.fromisoformat(h.get("timestamp", "1970-01-01")) > now - timedelta(hours=1)
    ]

    last_24h = [
        h for h in history
        if datetime.fromisoformat(h.get("timestamp", "1970-01-01")) > now - timedelta(hours=24)
    ]

    status = await doctor.get_status()

    return {
        "running": doctor.running,
        "last_check": status.get("last_check"),
        "current_problems": status.get("problems_count", 0),
        "actions_this_hour": doctor.actions_this_hour,
        "max_actions_per_hour": doctor.config.get("max_actions_per_hour", 20),
        "stats": {
            "total_actions": total,
            "successful": successful,
            "failed": total - successful,
            "success_rate": f"{(successful / total * 100):.1f}%" if total > 0 else "N/A",
            "last_hour": len(last_hour),
            "last_24h": len(last_24h)
        }
    }
