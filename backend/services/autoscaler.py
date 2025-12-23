"""
Fleet Commander Auto-Scaler Service
Monitors queue depth and node utilization to make scaling decisions.
"""
import asyncio
import redis.asyncio as redis
import json
from datetime import datetime, timedelta
from typing import Dict, Any, Optional, List
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class AutoScaler:
    """
    Auto-scaling service that monitors queue depth and GPU utilization
    to make scaling decisions for the fleet.
    """

    def __init__(self, redis_url: str = "redis://localhost:6379"):
        self.redis_url = redis_url
        self.r = None
        self.running = False

        # Configuration keys
        self.SCALING_CONFIG = "fleet:scaling:config"
        self.SCALING_STATE = "fleet:scaling:state"
        self.SCALING_HISTORY = "fleet:scaling:history"

        # Queue keys
        self.QUEUE_HIGH = "fleet:queue:high"
        self.QUEUE_NORMAL = "fleet:queue:normal"
        self.QUEUE_LOW = "fleet:queue:low"

    async def connect(self):
        """Initialize Redis connection."""
        self.r = redis.from_url(self.redis_url, decode_responses=True)
        logger.info("AutoScaler connected to Redis")

    async def disconnect(self):
        """Close Redis connection."""
        if self.r:
            await self.r.close()

    async def get_config(self) -> Dict[str, Any]:
        """Get scaling configuration."""
        data = await self.r.get(self.SCALING_CONFIG)
        if data:
            return json.loads(data)
        # Default config
        return {
            "enabled": True,
            "min_nodes": 1,
            "max_nodes": 16,
            "target_queue_depth": 10,
            "scale_up_threshold": 0.8,  # 80% GPU utilization
            "scale_down_threshold": 0.2,  # 20% GPU utilization
            "cooldown_seconds": 300,
            "check_interval_seconds": 30,
        }

    async def get_state(self) -> Dict[str, Any]:
        """Get current scaling state."""
        data = await self.r.get(self.SCALING_STATE)
        if data:
            return json.loads(data)
        return {}

    async def set_state(self, state: Dict[str, Any]):
        """Update scaling state."""
        await self.r.set(self.SCALING_STATE, json.dumps(state))

    async def get_queue_depth(self) -> Dict[str, int]:
        """Get current queue depths."""
        high = await self.r.llen(self.QUEUE_HIGH)
        normal = await self.r.llen(self.QUEUE_NORMAL)
        low = await self.r.llen(self.QUEUE_LOW)
        return {
            "high": high,
            "normal": normal,
            "low": low,
            "total": high + normal + low,
            "weighted": high * 3 + normal * 2 + low  # Weighted priority
        }

    async def get_node_metrics(self) -> Dict[str, Any]:
        """Get metrics from all active nodes."""
        node_ids = await self.r.smembers("nodes:active")
        nodes = []
        total_gpu_util = 0
        total_power = 0
        computing_count = 0

        for nid in node_ids:
            data = await self.r.get(f"node:{nid}:heartbeat")
            if data:
                node = json.loads(data)
                node["node_id"] = nid
                nodes.append(node)

                # Aggregate metrics
                gpu = node.get("gpu") or {}
                total_gpu_util += gpu.get("utilization", 0)

                power = node.get("power") or {}
                total_power += power.get("total_w", 0)

                activity = node.get("activity") or {}
                if activity.get("status") == "computing":
                    computing_count += 1

        active_count = len(nodes)
        avg_gpu_util = total_gpu_util / active_count if active_count > 0 else 0

        return {
            "nodes": nodes,
            "active_count": active_count,
            "computing_count": computing_count,
            "avg_gpu_utilization": avg_gpu_util,
            "total_power_w": total_power,
        }

    async def get_idle_nodes(self, nodes: List[Dict]) -> List[Dict]:
        """Get nodes that are idle (low GPU usage, no containers)."""
        idle = []
        for node in nodes:
            activity = node.get("activity") or {}
            gpu = node.get("gpu") or {}

            if (
                activity.get("status") in ["idle", "ready"]
                and gpu.get("utilization", 0) < 10
                and activity.get("containers", 0) == 0
            ):
                idle.append(node)
        return idle

    async def get_roamer_nodes(self, nodes: List[Dict]) -> List[Dict]:
        """Get roamer nodes that can be dynamically assigned."""
        roamers = []
        for node in nodes:
            nid = node.get("node_id", "").lower()
            # Roamers are agx12-15 based on current cluster config
            import re
            match = re.match(r'agx-?(\d+)', nid)
            if match:
                num = int(match.group(1))
                if num >= 12:
                    roamers.append(node)
        return roamers

    async def evaluate(self) -> Dict[str, Any]:
        """
        Evaluate current state and determine scaling action.
        Returns scaling decision with reason.
        """
        config = await self.get_config()
        state = await self.get_state()

        if not config.get("enabled", True):
            return {"action": "none", "reason": "Auto-scaling disabled"}

        # Check cooldown
        last_scale_time = state.get("last_scale_time")
        if last_scale_time:
            cooldown_end = datetime.fromisoformat(last_scale_time) + timedelta(
                seconds=config["cooldown_seconds"]
            )
            if datetime.utcnow() < cooldown_end:
                remaining = (cooldown_end - datetime.utcnow()).seconds
                return {
                    "action": "none",
                    "reason": f"In cooldown period ({remaining}s remaining)"
                }

        # Get metrics
        queue = await self.get_queue_depth()
        metrics = await self.get_node_metrics()

        active_nodes = metrics["active_count"]
        avg_gpu_util = metrics["avg_gpu_utilization"]
        queue_depth = queue["total"]
        weighted_queue = queue["weighted"]

        decision = {
            "action": "none",
            "reason": None,
            "current_nodes": active_nodes,
            "recommended_nodes": active_nodes,
            "queue_depth": queue_depth,
            "avg_gpu_utilization": round(avg_gpu_util, 1),
            "timestamp": datetime.utcnow().isoformat(),
        }

        # Scale UP conditions
        scale_up_reasons = []
        if queue_depth > config["target_queue_depth"]:
            scale_up_reasons.append(f"Queue depth ({queue_depth}) > target ({config['target_queue_depth']})")

        if avg_gpu_util > config["scale_up_threshold"] * 100:
            scale_up_reasons.append(f"GPU util ({avg_gpu_util:.1f}%) > threshold ({config['scale_up_threshold']*100}%)")

        if scale_up_reasons and active_nodes < config["max_nodes"]:
            # Calculate how many nodes to add
            nodes_needed = max(1, queue_depth // config["target_queue_depth"])
            new_count = min(active_nodes + nodes_needed, config["max_nodes"])

            decision["action"] = "scale_up"
            decision["recommended_nodes"] = new_count
            decision["reason"] = " AND ".join(scale_up_reasons)

            # Find idle roamer nodes that can be activated
            idle_roamers = await self.get_idle_nodes(
                await self.get_roamer_nodes(metrics["nodes"])
            )
            decision["available_roamers"] = len(idle_roamers)

        # Scale DOWN conditions
        elif active_nodes > config["min_nodes"]:
            scale_down_reasons = []

            if queue_depth < config["target_queue_depth"] // 2:
                scale_down_reasons.append(f"Queue depth ({queue_depth}) < target/2")

            if avg_gpu_util < config["scale_down_threshold"] * 100:
                scale_down_reasons.append(f"GPU util ({avg_gpu_util:.1f}%) < threshold ({config['scale_down_threshold']*100}%)")

            if len(scale_down_reasons) >= 2:  # Need both conditions for scale down
                idle_nodes = await self.get_idle_nodes(metrics["nodes"])
                if idle_nodes:
                    decision["action"] = "scale_down"
                    decision["recommended_nodes"] = max(
                        active_nodes - len(idle_nodes), config["min_nodes"]
                    )
                    decision["reason"] = " AND ".join(scale_down_reasons)
                    decision["idle_nodes"] = [n["node_id"] for n in idle_nodes]

        # Record decision in history
        await self.r.lpush(self.SCALING_HISTORY, json.dumps(decision))
        await self.r.ltrim(self.SCALING_HISTORY, 0, 99)  # Keep last 100

        # Update state if action taken
        if decision["action"] != "none":
            state["last_scale_action"] = decision["action"]
            state["last_scale_time"] = decision["timestamp"]
            state["last_reason"] = decision["reason"]

        state["last_evaluation"] = decision["timestamp"]
        state["current_scale"] = active_nodes
        state["recommended_scale"] = decision["recommended_nodes"]
        state["queue_depth"] = queue_depth
        state["avg_gpu_utilization"] = decision["avg_gpu_utilization"]
        state["action"] = decision["action"]
        state["reason"] = decision["reason"]

        await self.set_state(state)

        return decision

    async def execute_scaling(self, decision: Dict[str, Any]) -> bool:
        """
        Execute scaling action (placeholder for actual implementation).
        In a real system, this would:
        - Scale UP: Wake up idle nodes, reassign roamers
        - Scale DOWN: Gracefully drain and sleep idle nodes
        """
        action = decision.get("action")

        if action == "none":
            return True

        if action == "scale_up":
            logger.info(
                f"SCALE UP: {decision['current_nodes']} -> {decision['recommended_nodes']} nodes"
            )
            logger.info(f"Reason: {decision['reason']}")
            # TODO: Implement actual node activation
            # - Send WoL packets to sleeping nodes
            # - Reassign roamer nodes to busy clusters
            # - Start containers on idle nodes
            return True

        if action == "scale_down":
            logger.info(
                f"SCALE DOWN: {decision['current_nodes']} -> {decision['recommended_nodes']} nodes"
            )
            logger.info(f"Reason: {decision['reason']}")
            logger.info(f"Idle nodes: {decision.get('idle_nodes', [])}")
            # TODO: Implement actual node deactivation
            # - Gracefully stop containers
            # - Mark nodes as "draining"
            # - Send sleep commands after containers stopped
            return True

        return False

    async def run(self):
        """Main loop - evaluate and optionally execute scaling decisions."""
        self.running = True
        logger.info("AutoScaler started")

        while self.running:
            try:
                config = await self.get_config()
                interval = config.get("check_interval_seconds", 30)

                # Evaluate scaling needs
                decision = await self.evaluate()
                logger.info(
                    f"Scaling evaluation: action={decision['action']}, "
                    f"queue={decision['queue_depth']}, "
                    f"gpu={decision['avg_gpu_utilization']:.1f}%"
                )

                if decision["action"] != "none":
                    await self.execute_scaling(decision)

                # Wait for next check
                await asyncio.sleep(interval)

            except Exception as e:
                logger.error(f"AutoScaler error: {e}")
                await asyncio.sleep(10)  # Brief pause on error

        logger.info("AutoScaler stopped")

    def stop(self):
        """Stop the autoscaler loop."""
        self.running = False


async def main():
    """Run autoscaler as standalone service."""
    import os
    redis_url = os.environ.get("REDIS_URL", "redis://localhost:6379")

    scaler = AutoScaler(redis_url)
    await scaler.connect()

    try:
        await scaler.run()
    finally:
        await scaler.disconnect()


if __name__ == "__main__":
    asyncio.run(main())
