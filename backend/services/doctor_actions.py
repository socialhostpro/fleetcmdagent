"""
Fleet Doctor Action Definitions and Executor

Defines available remediation actions and how to execute them.
"""

import json
import asyncio
from datetime import datetime
from typing import Optional, Dict, Any, List
from dataclasses import dataclass, asdict
import httpx


@dataclass
class ActionResult:
    """Result of executing an action."""
    success: bool
    action: str
    node_id: Optional[str]
    message: str
    details: Dict[str, Any]
    executed_at: str
    duration_ms: float

    def to_dict(self) -> dict:
        return asdict(self)


# Available remediation actions
ACTIONS = {
    "disk_cleanup": {
        "description": "Clean up disk space (Docker, logs, apt cache, tmp)",
        "endpoint": "/api/maintenance/disk/cleanup",
        "method": "POST",
        "default_params": {"actions": ["docker", "logs", "apt", "tmp"]},
        "risk_level": "low",
        "requires_node": True
    },
    "aggressive_cleanup": {
        "description": "Aggressive disk cleanup including pip cache and journals",
        "endpoint": "/api/maintenance/disk/cleanup",
        "method": "POST",
        "default_params": {"actions": ["docker", "logs", "apt", "tmp", "pip", "journal"]},
        "risk_level": "medium",
        "requires_node": True
    },
    "restart_agent": {
        "description": "Restart the fleet-agent service on the node",
        "endpoint": "/api/maintenance/restart-agent",
        "method": "POST",
        "default_params": {},
        "risk_level": "low",
        "requires_node": True
    },
    "fix_s3_mounts": {
        "description": "Fix S3/MinIO mount points on the node",
        "endpoint": "/api/maintenance/fix-s3-mounts",
        "method": "POST",
        "default_params": {},
        "risk_level": "low",
        "requires_node": True
    },
    "health_check": {
        "description": "Run a comprehensive health check on the node",
        "endpoint": "/api/maintenance/health-check",
        "method": "POST",
        "default_params": {},
        "risk_level": "low",
        "requires_node": True
    },
    "prune_docker": {
        "description": "Prune Docker images, containers, and volumes",
        "endpoint": "/api/maintenance/disk/cleanup",
        "method": "POST",
        "default_params": {"actions": ["docker"]},
        "risk_level": "low",
        "requires_node": True
    },
    "retry_job": {
        "description": "Retry a failed job",
        "endpoint": "/api/queue/jobs/{job_id}/retry",
        "method": "POST",
        "default_params": {},
        "risk_level": "low",
        "requires_node": False
    },
    "alert_only": {
        "description": "No action - just log and alert",
        "endpoint": None,
        "method": None,
        "default_params": {},
        "risk_level": "low",
        "requires_node": False
    }
}


# Map problem types to default actions
PROBLEM_ACTION_MAP = {
    "high_disk": "disk_cleanup",
    "critical_disk": "aggressive_cleanup",
    "high_memory": "alert_only",
    "offline_node": "alert_only",
    "docker_down": "alert_only",  # Too risky for auto-restart
    "agent_down": "restart_agent",
    "s3_mount_missing": "fix_s3_mounts",
    "swarm_unhealthy": "alert_only",
    "job_failures": "alert_only"
}


class ActionExecutor:
    """Executes remediation actions against the Fleet Commander API."""

    def __init__(self, api_base_url: str = "http://localhost:8765"):
        self.api_base_url = api_base_url
        self.client = httpx.AsyncClient(timeout=120.0)

    async def close(self):
        await self.client.aclose()

    async def execute(
        self,
        action_name: str,
        node_id: Optional[str] = None,
        params: Optional[Dict[str, Any]] = None,
        credential_id: Optional[str] = None
    ) -> ActionResult:
        """Execute a remediation action."""
        start_time = datetime.utcnow()

        if action_name not in ACTIONS:
            return ActionResult(
                success=False,
                action=action_name,
                node_id=node_id,
                message=f"Unknown action: {action_name}",
                details={"error": "Action not found"},
                executed_at=start_time.isoformat(),
                duration_ms=0
            )

        action_def = ACTIONS[action_name]

        # Handle alert_only - no actual action
        if action_def["endpoint"] is None:
            return ActionResult(
                success=True,
                action=action_name,
                node_id=node_id,
                message="Alert logged (no auto-fix action taken)",
                details={"action": "alert_only"},
                executed_at=start_time.isoformat(),
                duration_ms=0
            )

        # Check if node is required
        if action_def["requires_node"] and not node_id:
            return ActionResult(
                success=False,
                action=action_name,
                node_id=node_id,
                message="Node ID required for this action",
                details={"error": "Missing node_id"},
                executed_at=start_time.isoformat(),
                duration_ms=0
            )

        # Build request
        endpoint = action_def["endpoint"]
        if "{job_id}" in endpoint:
            job_id = params.get("job_id") if params else None
            if not job_id:
                return ActionResult(
                    success=False,
                    action=action_name,
                    node_id=node_id,
                    message="Job ID required for retry action",
                    details={"error": "Missing job_id"},
                    executed_at=start_time.isoformat(),
                    duration_ms=0
                )
            endpoint = endpoint.replace("{job_id}", job_id)

        url = f"{self.api_base_url}{endpoint}"
        method = action_def["method"]

        # Merge default params with provided params
        request_body = {**action_def["default_params"]}
        if params:
            request_body.update(params)

        # Add node info
        if node_id:
            request_body["node_id"] = node_id
        if credential_id:
            request_body["credential_id"] = credential_id

        try:
            if method == "POST":
                response = await self.client.post(url, json=request_body)
            elif method == "GET":
                response = await self.client.get(url, params=request_body)
            else:
                raise ValueError(f"Unsupported method: {method}")

            end_time = datetime.utcnow()
            duration_ms = (end_time - start_time).total_seconds() * 1000

            if response.status_code in [200, 201, 202]:
                try:
                    result_data = response.json()
                except:
                    result_data = {"raw": response.text}

                return ActionResult(
                    success=True,
                    action=action_name,
                    node_id=node_id,
                    message=f"Action {action_name} completed successfully",
                    details=result_data,
                    executed_at=start_time.isoformat(),
                    duration_ms=duration_ms
                )
            else:
                return ActionResult(
                    success=False,
                    action=action_name,
                    node_id=node_id,
                    message=f"Action failed with status {response.status_code}",
                    details={"status_code": response.status_code, "response": response.text[:500]},
                    executed_at=start_time.isoformat(),
                    duration_ms=duration_ms
                )

        except Exception as e:
            end_time = datetime.utcnow()
            duration_ms = (end_time - start_time).total_seconds() * 1000

            return ActionResult(
                success=False,
                action=action_name,
                node_id=node_id,
                message=f"Action execution error: {str(e)}",
                details={"error": str(e), "error_type": type(e).__name__},
                executed_at=start_time.isoformat(),
                duration_ms=duration_ms
            )

    def get_default_action(self, problem_type: str) -> str:
        """Get the default action for a problem type."""
        return PROBLEM_ACTION_MAP.get(problem_type, "alert_only")

    def get_action_info(self, action_name: str) -> Optional[Dict[str, Any]]:
        """Get information about an action."""
        return ACTIONS.get(action_name)

    def list_actions(self) -> List[Dict[str, Any]]:
        """List all available actions."""
        return [
            {"name": name, **info}
            for name, info in ACTIONS.items()
        ]
