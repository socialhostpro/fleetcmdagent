"""
Fleet Doctor Problem Detection

Defines problem types and detectors that scan for issues in the fleet.
Each detector checks a specific aspect of system health.
"""

import json
from datetime import datetime
from typing import Optional, List, Dict, Any
from dataclasses import dataclass, asdict
from enum import Enum


class Severity(str, Enum):
    INFO = "info"
    WARNING = "warning"
    CRITICAL = "critical"


class ProblemType(str, Enum):
    OFFLINE_NODE = "offline_node"
    HIGH_DISK = "high_disk"
    CRITICAL_DISK = "critical_disk"
    HIGH_MEMORY = "high_memory"
    DOCKER_DOWN = "docker_down"
    AGENT_DOWN = "agent_down"
    S3_MOUNT_MISSING = "s3_mount_missing"
    SWARM_UNHEALTHY = "swarm_unhealthy"
    JOB_FAILURES = "job_failures"
    HIGH_GPU_TEMP = "high_gpu_temp"


@dataclass
class Problem:
    """Represents a detected problem in the fleet."""
    id: str
    type: ProblemType
    severity: Severity
    node_id: Optional[str]
    title: str
    description: str
    details: Dict[str, Any]
    detected_at: str
    auto_fixable: bool = True
    risk_level: str = "low"  # low, medium, high

    def to_dict(self) -> dict:
        d = asdict(self)
        d['type'] = self.type.value
        d['severity'] = self.severity.value
        return d

    def to_json(self) -> str:
        return json.dumps(self.to_dict())


class BaseDetector:
    """Base class for problem detectors."""

    async def detect(self, redis_client, config: dict) -> List[Problem]:
        """Detect problems. Override in subclasses."""
        raise NotImplementedError


class OfflineNodeDetector(BaseDetector):
    """Detects nodes that have stopped sending heartbeats."""

    async def detect(self, redis_client, config: dict) -> List[Problem]:
        problems = []

        # Get all known nodes from the active set
        node_ids = await redis_client.smembers("nodes:active")

        for node_id in node_ids:
            heartbeat = await redis_client.get(f"node:{node_id}:heartbeat")
            if not heartbeat:
                # Node is in active set but has no heartbeat (expired)
                problems.append(Problem(
                    id=f"offline_{node_id}_{datetime.utcnow().strftime('%Y%m%d%H%M%S')}",
                    type=ProblemType.OFFLINE_NODE,
                    severity=Severity.CRITICAL,
                    node_id=node_id,
                    title=f"Node {node_id} is offline",
                    description=f"Node {node_id} has not sent a heartbeat in over 2 minutes",
                    details={"node_id": node_id, "last_seen": "unknown"},
                    detected_at=datetime.utcnow().isoformat(),
                    auto_fixable=False,  # Requires physical intervention
                    risk_level="high"
                ))

        return problems


class HighDiskDetector(BaseDetector):
    """Detects nodes with high disk usage."""

    async def detect(self, redis_client, config: dict) -> List[Problem]:
        problems = []
        warning_threshold = config.get("disk_threshold", 85)
        critical_threshold = config.get("disk_critical_threshold", 95)

        node_ids = await redis_client.smembers("nodes:active")

        for node_id in node_ids:
            heartbeat_json = await redis_client.get(f"node:{node_id}:heartbeat")
            if not heartbeat_json:
                continue

            heartbeat = json.loads(heartbeat_json)
            disk = heartbeat.get("disk", {})
            disk_percent = disk.get("percent", 0)

            if disk_percent >= critical_threshold:
                problems.append(Problem(
                    id=f"critical_disk_{node_id}_{datetime.utcnow().strftime('%Y%m%d%H%M%S')}",
                    type=ProblemType.CRITICAL_DISK,
                    severity=Severity.CRITICAL,
                    node_id=node_id,
                    title=f"Critical disk usage on {node_id}: {disk_percent:.1f}%",
                    description=f"Node {node_id} disk usage is critically high at {disk_percent:.1f}%",
                    details={
                        "node_id": node_id,
                        "disk_percent": disk_percent,
                        "disk_total": disk.get("total", 0),
                        "disk_free": disk.get("free", 0)
                    },
                    detected_at=datetime.utcnow().isoformat(),
                    auto_fixable=True,
                    risk_level="medium"
                ))
            elif disk_percent >= warning_threshold:
                problems.append(Problem(
                    id=f"high_disk_{node_id}_{datetime.utcnow().strftime('%Y%m%d%H%M%S')}",
                    type=ProblemType.HIGH_DISK,
                    severity=Severity.WARNING,
                    node_id=node_id,
                    title=f"High disk usage on {node_id}: {disk_percent:.1f}%",
                    description=f"Node {node_id} disk usage is elevated at {disk_percent:.1f}%",
                    details={
                        "node_id": node_id,
                        "disk_percent": disk_percent,
                        "disk_total": disk.get("total", 0),
                        "disk_free": disk.get("free", 0)
                    },
                    detected_at=datetime.utcnow().isoformat(),
                    auto_fixable=True,
                    risk_level="low"
                ))

        return problems


class HighMemoryDetector(BaseDetector):
    """Detects nodes with high memory usage."""

    async def detect(self, redis_client, config: dict) -> List[Problem]:
        problems = []
        threshold = config.get("memory_threshold", 90)

        node_ids = await redis_client.smembers("nodes:active")

        for node_id in node_ids:
            heartbeat_json = await redis_client.get(f"node:{node_id}:heartbeat")
            if not heartbeat_json:
                continue

            heartbeat = json.loads(heartbeat_json)
            memory = heartbeat.get("memory", {})
            memory_percent = memory.get("percent", 0)

            if memory_percent >= threshold:
                problems.append(Problem(
                    id=f"high_memory_{node_id}_{datetime.utcnow().strftime('%Y%m%d%H%M%S')}",
                    type=ProblemType.HIGH_MEMORY,
                    severity=Severity.WARNING,
                    node_id=node_id,
                    title=f"High memory usage on {node_id}: {memory_percent:.1f}%",
                    description=f"Node {node_id} memory usage is elevated at {memory_percent:.1f}%",
                    details={
                        "node_id": node_id,
                        "memory_percent": memory_percent,
                        "memory_total": memory.get("total", 0),
                        "memory_available": memory.get("available", 0)
                    },
                    detected_at=datetime.utcnow().isoformat(),
                    auto_fixable=False,  # Memory issues often need manual intervention
                    risk_level="medium"
                ))

        return problems


class SwarmHealthDetector(BaseDetector):
    """Detects unhealthy Docker Swarm nodes."""

    async def detect(self, redis_client, config: dict) -> List[Problem]:
        problems = []

        # Check swarm status from Redis cache
        swarm_status = await redis_client.get("fleet:swarm:status")
        if not swarm_status:
            return problems

        status = json.loads(swarm_status)
        nodes = status.get("nodes", [])

        for node in nodes:
            state = node.get("status", {}).get("state", "unknown")
            availability = node.get("spec", {}).get("availability", "unknown")
            hostname = node.get("description", {}).get("hostname", "unknown")

            if state != "ready" or availability != "active":
                problems.append(Problem(
                    id=f"swarm_unhealthy_{hostname}_{datetime.utcnow().strftime('%Y%m%d%H%M%S')}",
                    type=ProblemType.SWARM_UNHEALTHY,
                    severity=Severity.WARNING,
                    node_id=hostname,
                    title=f"Swarm node {hostname} is not ready",
                    description=f"Docker Swarm node {hostname} state: {state}, availability: {availability}",
                    details={
                        "hostname": hostname,
                        "state": state,
                        "availability": availability,
                        "node_info": node
                    },
                    detected_at=datetime.utcnow().isoformat(),
                    auto_fixable=True,
                    risk_level="medium"
                ))

        return problems


class JobFailureDetector(BaseDetector):
    """Detects jobs that are failing repeatedly."""

    async def detect(self, redis_client, config: dict) -> List[Problem]:
        problems = []
        failure_threshold = config.get("job_failure_threshold", 3)

        # Get recent job failures
        failed_jobs = await redis_client.lrange("fleet:jobs:failed", 0, 50)

        # Count failures per job type/workflow
        failure_counts = {}
        for job_json in failed_jobs:
            try:
                job = json.loads(job_json)
                job_type = job.get("workflow", job.get("type", "unknown"))
                failure_counts[job_type] = failure_counts.get(job_type, 0) + 1
            except:
                continue

        for job_type, count in failure_counts.items():
            if count >= failure_threshold:
                problems.append(Problem(
                    id=f"job_failures_{job_type}_{datetime.utcnow().strftime('%Y%m%d%H%M%S')}",
                    type=ProblemType.JOB_FAILURES,
                    severity=Severity.WARNING,
                    node_id=None,
                    title=f"Job type '{job_type}' failing repeatedly ({count} failures)",
                    description=f"Jobs of type '{job_type}' have failed {count} times recently",
                    details={
                        "job_type": job_type,
                        "failure_count": count,
                        "threshold": failure_threshold
                    },
                    detected_at=datetime.utcnow().isoformat(),
                    auto_fixable=True,
                    risk_level="low"
                ))

        return problems


# Registry of all detectors
PROBLEM_DETECTORS = [
    OfflineNodeDetector(),
    HighDiskDetector(),
    HighMemoryDetector(),
    SwarmHealthDetector(),
    JobFailureDetector(),
]


async def detect_all_problems(redis_client, config: dict) -> List[Problem]:
    """Run all detectors and return combined list of problems."""
    all_problems = []

    for detector in PROBLEM_DETECTORS:
        try:
            problems = await detector.detect(redis_client, config)
            all_problems.extend(problems)
        except Exception as e:
            print(f"Error in detector {detector.__class__.__name__}: {e}")

    return all_problems
