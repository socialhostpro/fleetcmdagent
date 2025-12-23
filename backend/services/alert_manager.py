"""
Alert Manager Service

Monitors fleet health and generates alerts based on configurable rules.
Alerts are stored in Redis and broadcast via WebSocket.
"""
import asyncio
import json
import os
import uuid
from dataclasses import dataclass, asdict, field
from datetime import datetime, timedelta
from enum import Enum
from typing import Optional, List, Dict, Any, Callable
import redis.asyncio as redis


class AlertSeverity(str, Enum):
    INFO = "info"
    WARNING = "warning"
    ERROR = "error"
    CRITICAL = "critical"


class AlertStatus(str, Enum):
    ACTIVE = "active"
    ACKNOWLEDGED = "acknowledged"
    RESOLVED = "resolved"


@dataclass
class Alert:
    id: str
    rule_id: str
    severity: AlertSeverity
    title: str
    message: str
    node_id: Optional[str] = None
    cluster: Optional[str] = None
    created_at: str = ""
    updated_at: str = ""
    status: AlertStatus = AlertStatus.ACTIVE
    acknowledged_by: Optional[str] = None
    acknowledged_at: Optional[str] = None
    resolved_at: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self):
        return {
            "id": self.id,
            "rule_id": self.rule_id,
            "severity": self.severity.value,
            "title": self.title,
            "message": self.message,
            "node_id": self.node_id,
            "cluster": self.cluster,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "status": self.status.value,
            "acknowledged_by": self.acknowledged_by,
            "acknowledged_at": self.acknowledged_at,
            "resolved_at": self.resolved_at,
            "metadata": self.metadata,
        }


@dataclass
class AlertRule:
    id: str
    name: str
    description: str
    severity: AlertSeverity
    condition: str  # e.g., "gpu_utilization > 95", "node_offline", "disk_usage > 90"
    threshold: Optional[float] = None
    duration_seconds: int = 0  # How long condition must persist
    cooldown_seconds: int = 300  # Minimum time between alerts
    enabled: bool = True


class AlertManager:
    """Manages alerts for the fleet."""

    # Default alert rules
    DEFAULT_RULES = [
        AlertRule(
            id="node_offline",
            name="Node Offline",
            description="Node has not sent heartbeat",
            severity=AlertSeverity.CRITICAL,
            condition="node_offline",
            duration_seconds=30,
            cooldown_seconds=300,
        ),
        AlertRule(
            id="gpu_high_util",
            name="GPU High Utilization",
            description="GPU utilization above threshold",
            severity=AlertSeverity.WARNING,
            condition="gpu_utilization",
            threshold=95,
            duration_seconds=300,
            cooldown_seconds=600,
        ),
        AlertRule(
            id="gpu_high_temp",
            name="GPU High Temperature",
            description="GPU temperature above threshold",
            severity=AlertSeverity.WARNING,
            condition="gpu_temperature",
            threshold=85,
            duration_seconds=60,
            cooldown_seconds=300,
        ),
        AlertRule(
            id="disk_low",
            name="Disk Space Low",
            description="Disk usage above threshold",
            severity=AlertSeverity.WARNING,
            condition="disk_usage",
            threshold=90,
            duration_seconds=0,
            cooldown_seconds=3600,
        ),
        AlertRule(
            id="disk_critical",
            name="Disk Space Critical",
            description="Disk space critically low",
            severity=AlertSeverity.CRITICAL,
            condition="disk_usage",
            threshold=95,
            duration_seconds=0,
            cooldown_seconds=1800,
        ),
        AlertRule(
            id="memory_high",
            name="Memory High Usage",
            description="Memory usage above threshold",
            severity=AlertSeverity.WARNING,
            condition="memory_usage",
            threshold=90,
            duration_seconds=60,
            cooldown_seconds=600,
        ),
        AlertRule(
            id="job_failed",
            name="Job Failed",
            description="A job has failed",
            severity=AlertSeverity.ERROR,
            condition="job_failed",
            duration_seconds=0,
            cooldown_seconds=0,
        ),
        AlertRule(
            id="queue_backed_up",
            name="Queue Backed Up",
            description="Job queue has too many pending jobs",
            severity=AlertSeverity.WARNING,
            condition="queue_size",
            threshold=100,
            duration_seconds=300,
            cooldown_seconds=900,
        ),
        AlertRule(
            id="container_crashed",
            name="Container Crashed",
            description="A container has crashed or restarted",
            severity=AlertSeverity.ERROR,
            condition="container_crashed",
            duration_seconds=0,
            cooldown_seconds=300,
        ),
    ]

    def __init__(self, redis_url: str = "redis://comfyui-redis:6379"):
        self.redis_url = redis_url
        self.redis: Optional[redis.Redis] = None
        self.running = False
        self.rules: Dict[str, AlertRule] = {}
        self.last_alert_times: Dict[str, datetime] = {}
        self.condition_start_times: Dict[str, datetime] = {}
        self.check_interval = 5  # seconds

    async def connect(self):
        """Connect to Redis."""
        self.redis = redis.from_url(self.redis_url, decode_responses=True)
        await self._load_rules()
        print("AlertManager connected")

    async def disconnect(self):
        """Disconnect from Redis."""
        if self.redis:
            await self.redis.close()

    async def _load_rules(self):
        """Load alert rules from Redis or use defaults."""
        # Load custom rules from Redis
        stored_rules = await self.redis.get("alert:rules")
        if stored_rules:
            rules_data = json.loads(stored_rules)
            for rule_data in rules_data:
                rule = AlertRule(**rule_data)
                self.rules[rule.id] = rule
        else:
            # Use default rules
            for rule in self.DEFAULT_RULES:
                self.rules[rule.id] = rule
            await self._save_rules()

    async def _save_rules(self):
        """Save rules to Redis."""
        rules_data = []
        for rule in self.rules.values():
            rules_data.append({
                "id": rule.id,
                "name": rule.name,
                "description": rule.description,
                "severity": rule.severity.value,
                "condition": rule.condition,
                "threshold": rule.threshold,
                "duration_seconds": rule.duration_seconds,
                "cooldown_seconds": rule.cooldown_seconds,
                "enabled": rule.enabled,
            })
        await self.redis.set("alert:rules", json.dumps(rules_data))

    async def create_alert(
        self,
        rule: AlertRule,
        node_id: Optional[str] = None,
        cluster: Optional[str] = None,
        message: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Alert:
        """Create and store a new alert."""
        now = datetime.utcnow().isoformat()
        alert_id = str(uuid.uuid4())[:8]

        alert = Alert(
            id=alert_id,
            rule_id=rule.id,
            severity=rule.severity,
            title=rule.name,
            message=message or rule.description,
            node_id=node_id,
            cluster=cluster,
            created_at=now,
            updated_at=now,
            metadata=metadata or {},
        )

        # Store in Redis
        await self.redis.hset(f"alert:{alert_id}", mapping={"data": json.dumps(alert.to_dict())})
        await self.redis.sadd("alerts:active", alert_id)
        await self.redis.zadd("alerts:history", {alert_id: datetime.utcnow().timestamp()})

        # Publish for real-time updates
        await self.redis.publish("alerts", json.dumps({
            "type": "new_alert",
            "alert": alert.to_dict()
        }))

        # Track last alert time for cooldown
        cooldown_key = f"{rule.id}:{node_id or 'global'}"
        self.last_alert_times[cooldown_key] = datetime.utcnow()

        print(f"Alert created: [{alert.severity.value.upper()}] {alert.title} - {alert.message}")
        return alert

    async def acknowledge_alert(self, alert_id: str, acknowledged_by: str = "system") -> Optional[Alert]:
        """Acknowledge an alert."""
        alert_data = await self.redis.hget(f"alert:{alert_id}", "data")
        if not alert_data:
            return None

        alert_dict = json.loads(alert_data)
        alert_dict["status"] = AlertStatus.ACKNOWLEDGED.value
        alert_dict["acknowledged_by"] = acknowledged_by
        alert_dict["acknowledged_at"] = datetime.utcnow().isoformat()
        alert_dict["updated_at"] = datetime.utcnow().isoformat()

        await self.redis.hset(f"alert:{alert_id}", mapping={"data": json.dumps(alert_dict)})

        # Publish update
        await self.redis.publish("alerts", json.dumps({
            "type": "alert_acknowledged",
            "alert_id": alert_id,
            "acknowledged_by": acknowledged_by
        }))

        return Alert(**{k: AlertSeverity(v) if k == "severity" else AlertStatus(v) if k == "status" else v for k, v in alert_dict.items()})

    async def resolve_alert(self, alert_id: str) -> Optional[Alert]:
        """Resolve an alert."""
        alert_data = await self.redis.hget(f"alert:{alert_id}", "data")
        if not alert_data:
            return None

        alert_dict = json.loads(alert_data)
        alert_dict["status"] = AlertStatus.RESOLVED.value
        alert_dict["resolved_at"] = datetime.utcnow().isoformat()
        alert_dict["updated_at"] = datetime.utcnow().isoformat()

        await self.redis.hset(f"alert:{alert_id}", mapping={"data": json.dumps(alert_dict)})
        await self.redis.srem("alerts:active", alert_id)

        # Publish update
        await self.redis.publish("alerts", json.dumps({
            "type": "alert_resolved",
            "alert_id": alert_id
        }))

        return Alert(**{k: AlertSeverity(v) if k == "severity" else AlertStatus(v) if k == "status" else v for k, v in alert_dict.items()})

    async def get_active_alerts(self) -> List[Alert]:
        """Get all active alerts."""
        alert_ids = await self.redis.smembers("alerts:active")
        alerts = []

        for alert_id in alert_ids:
            alert_data = await self.redis.hget(f"alert:{alert_id}", "data")
            if alert_data:
                alert_dict = json.loads(alert_data)
                alerts.append(alert_dict)

        # Sort by severity then created_at
        severity_order = {"critical": 0, "error": 1, "warning": 2, "info": 3}
        alerts.sort(key=lambda a: (severity_order.get(a.get("severity", "info"), 4), a.get("created_at", "")))

        return alerts

    async def get_alert_history(self, limit: int = 100) -> List[Dict]:
        """Get recent alert history."""
        alert_ids = await self.redis.zrevrange("alerts:history", 0, limit - 1)
        alerts = []

        for alert_id in alert_ids:
            alert_data = await self.redis.hget(f"alert:{alert_id}", "data")
            if alert_data:
                alerts.append(json.loads(alert_data))

        return alerts

    def _can_alert(self, rule: AlertRule, node_id: Optional[str] = None) -> bool:
        """Check if we can create an alert (respecting cooldown)."""
        cooldown_key = f"{rule.id}:{node_id or 'global'}"
        last_alert = self.last_alert_times.get(cooldown_key)

        if not last_alert:
            return True

        elapsed = (datetime.utcnow() - last_alert).total_seconds()
        return elapsed >= rule.cooldown_seconds

    async def _check_node_offline(self, rule: AlertRule):
        """Check for offline nodes."""
        # Get all registered agents
        agent_ids = await self.redis.smembers("agents:registered")

        for node_id in agent_ids:
            # Check for heartbeat
            heartbeat = await self.redis.get(f"agent:heartbeat:{node_id}")

            if not heartbeat:
                # Node is offline
                condition_key = f"offline:{node_id}"

                if condition_key not in self.condition_start_times:
                    self.condition_start_times[condition_key] = datetime.utcnow()
                    continue

                elapsed = (datetime.utcnow() - self.condition_start_times[condition_key]).total_seconds()

                if elapsed >= rule.duration_seconds and self._can_alert(rule, node_id):
                    agent_data = await self.redis.hget(f"agent:{node_id}", "data")
                    cluster = None
                    if agent_data:
                        cluster = json.loads(agent_data).get("cluster")

                    await self.create_alert(
                        rule=rule,
                        node_id=node_id,
                        cluster=cluster,
                        message=f"Node {node_id} has been offline for {int(elapsed)} seconds",
                        metadata={"offline_duration": elapsed}
                    )
            else:
                # Node is online, clear condition
                condition_key = f"offline:{node_id}"
                if condition_key in self.condition_start_times:
                    del self.condition_start_times[condition_key]

                    # Auto-resolve offline alerts for this node
                    active_alerts = await self.redis.smembers("alerts:active")
                    for alert_id in active_alerts:
                        alert_data = await self.redis.hget(f"alert:{alert_id}", "data")
                        if alert_data:
                            alert = json.loads(alert_data)
                            if alert.get("rule_id") == "node_offline" and alert.get("node_id") == node_id:
                                await self.resolve_alert(alert_id)

    async def _check_gpu_metrics(self, rule: AlertRule):
        """Check GPU metrics (utilization or temperature)."""
        agent_ids = await self.redis.smembers("agents:registered")

        for node_id in agent_ids:
            heartbeat_raw = await self.redis.get(f"agent:heartbeat:{node_id}")
            if not heartbeat_raw:
                continue

            heartbeat = json.loads(heartbeat_raw)
            gpus = heartbeat.get("gpus", [])
            cluster = heartbeat.get("cluster")

            for gpu in gpus:
                gpu_idx = gpu.get("index", 0)

                if rule.condition == "gpu_utilization":
                    value = gpu.get("utilization", 0)
                elif rule.condition == "gpu_temperature":
                    value = gpu.get("temperature", 0)
                else:
                    continue

                condition_key = f"{rule.condition}:{node_id}:{gpu_idx}"

                if value >= rule.threshold:
                    if condition_key not in self.condition_start_times:
                        self.condition_start_times[condition_key] = datetime.utcnow()
                        continue

                    elapsed = (datetime.utcnow() - self.condition_start_times[condition_key]).total_seconds()

                    if elapsed >= rule.duration_seconds and self._can_alert(rule, node_id):
                        await self.create_alert(
                            rule=rule,
                            node_id=node_id,
                            cluster=cluster,
                            message=f"GPU {gpu_idx} on {node_id}: {rule.condition} at {value}% (threshold: {rule.threshold}%)",
                            metadata={"gpu_index": gpu_idx, "value": value, "threshold": rule.threshold}
                        )
                else:
                    if condition_key in self.condition_start_times:
                        del self.condition_start_times[condition_key]

    async def _check_disk_usage(self, rule: AlertRule):
        """Check disk usage on nodes."""
        agent_ids = await self.redis.smembers("agents:registered")

        for node_id in agent_ids:
            heartbeat_raw = await self.redis.get(f"agent:heartbeat:{node_id}")
            if not heartbeat_raw:
                continue

            heartbeat = json.loads(heartbeat_raw)
            system = heartbeat.get("system", {})
            disk_percent = system.get("disk_percent", 0)
            cluster = heartbeat.get("cluster")

            if disk_percent >= rule.threshold and self._can_alert(rule, node_id):
                await self.create_alert(
                    rule=rule,
                    node_id=node_id,
                    cluster=cluster,
                    message=f"Disk usage on {node_id}: {disk_percent:.1f}% (threshold: {rule.threshold}%)",
                    metadata={"disk_percent": disk_percent, "disk_free_gb": system.get("disk_free_gb", 0)}
                )

    async def _check_memory_usage(self, rule: AlertRule):
        """Check memory usage on nodes."""
        agent_ids = await self.redis.smembers("agents:registered")

        for node_id in agent_ids:
            heartbeat_raw = await self.redis.get(f"agent:heartbeat:{node_id}")
            if not heartbeat_raw:
                continue

            heartbeat = json.loads(heartbeat_raw)
            system = heartbeat.get("system", {})
            memory_percent = system.get("memory_percent", 0)
            cluster = heartbeat.get("cluster")

            condition_key = f"memory:{node_id}"

            if memory_percent >= rule.threshold:
                if condition_key not in self.condition_start_times:
                    self.condition_start_times[condition_key] = datetime.utcnow()
                    continue

                elapsed = (datetime.utcnow() - self.condition_start_times[condition_key]).total_seconds()

                if elapsed >= rule.duration_seconds and self._can_alert(rule, node_id):
                    await self.create_alert(
                        rule=rule,
                        node_id=node_id,
                        cluster=cluster,
                        message=f"Memory usage on {node_id}: {memory_percent:.1f}% (threshold: {rule.threshold}%)",
                        metadata={"memory_percent": memory_percent}
                    )
            else:
                if condition_key in self.condition_start_times:
                    del self.condition_start_times[condition_key]

    async def _check_queue_size(self, rule: AlertRule):
        """Check job queue size."""
        queue_size = await self.redis.llen("queue:jobs:pending")

        condition_key = "queue_size"

        if queue_size >= rule.threshold:
            if condition_key not in self.condition_start_times:
                self.condition_start_times[condition_key] = datetime.utcnow()
                return

            elapsed = (datetime.utcnow() - self.condition_start_times[condition_key]).total_seconds()

            if elapsed >= rule.duration_seconds and self._can_alert(rule):
                await self.create_alert(
                    rule=rule,
                    message=f"Job queue has {queue_size} pending jobs (threshold: {rule.threshold})",
                    metadata={"queue_size": queue_size}
                )
        else:
            if condition_key in self.condition_start_times:
                del self.condition_start_times[condition_key]

    async def _run_checks(self):
        """Run all enabled alert rule checks."""
        for rule in self.rules.values():
            if not rule.enabled:
                continue

            try:
                if rule.condition == "node_offline":
                    await self._check_node_offline(rule)
                elif rule.condition in ("gpu_utilization", "gpu_temperature"):
                    await self._check_gpu_metrics(rule)
                elif rule.condition == "disk_usage":
                    await self._check_disk_usage(rule)
                elif rule.condition == "memory_usage":
                    await self._check_memory_usage(rule)
                elif rule.condition == "queue_size":
                    await self._check_queue_size(rule)
            except Exception as e:
                print(f"Error checking rule {rule.id}: {e}")

    async def run(self):
        """Main monitoring loop."""
        self.running = True
        print("AlertManager monitoring started")

        while self.running:
            try:
                await self._run_checks()
            except Exception as e:
                print(f"AlertManager error: {e}")

            await asyncio.sleep(self.check_interval)

    def stop(self):
        """Stop the alert manager."""
        self.running = False


# Global instance
alert_manager: Optional[AlertManager] = None
