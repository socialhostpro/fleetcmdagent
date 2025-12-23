"""
Smart Queue/Model Scheduler for Vision Cluster

This service intelligently routes generation requests to the appropriate node
based on which model is currently loaded. If no node has the requested model,
it will switch the least busy node to that model.

Architecture:
- Nodes report their current model via heartbeat
- Queue items include target model
- Scheduler routes to node with matching model OR triggers model switch
"""
import asyncio
import json
import time
from typing import Dict, List, Optional, Any
from dataclasses import dataclass, asdict
from enum import Enum
import redis.asyncio as redis
import httpx
from config import settings

# Redis keys
QUEUE_KEY = "vision:queue"
NODE_STATUS_KEY = "vision:nodes"
MODEL_ROUTES_KEY = "vision:model_routes"
SCHEDULER_STATUS_KEY = "vision:scheduler:status"


class JobStatus(str, Enum):
    PENDING = "pending"
    ROUTING = "routing"
    MODEL_SWITCHING = "model_switching"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


@dataclass
class VisionNode:
    """Represents a vision processing node (AGX)."""
    node_id: str
    hostname: str
    ip: str
    port: int = 8080
    current_model: Optional[str] = None
    status: str = "offline"  # online, busy, offline, switching
    gpu_util: int = 0
    last_heartbeat: float = 0
    current_job_id: Optional[str] = None

    @property
    def is_available(self) -> bool:
        """Check if node is available for new jobs."""
        return (
            self.status == "online" and
            self.current_job_id is None and
            time.time() - self.last_heartbeat < 30
        )

    @property
    def is_online(self) -> bool:
        return time.time() - self.last_heartbeat < 30


@dataclass
class QueueJob:
    """A job in the vision queue."""
    job_id: str
    request_data: Dict[str, Any]
    target_model: str
    status: JobStatus = JobStatus.PENDING
    assigned_node: Optional[str] = None
    created_at: float = 0
    started_at: Optional[float] = None
    completed_at: Optional[float] = None
    result: Optional[Dict] = None
    error: Optional[str] = None
    priority: int = 0  # Higher = more priority

    def __post_init__(self):
        if self.created_at == 0:
            self.created_at = time.time()


class SmartScheduler:
    """
    Smart scheduler that routes jobs to nodes based on loaded models.

    Strategy:
    1. First, try to route to a node that already has the model loaded
    2. If no available node has the model, find the least busy node and switch
    3. Track model switches to minimize unnecessary switching
    """

    def __init__(self, redis_url: str = None):
        self.redis_url = redis_url or settings.REDIS_URL
        self.redis: Optional[redis.Redis] = None
        self.nodes: Dict[str, VisionNode] = {}
        self.running = False
        self._lock = asyncio.Lock()

    async def connect(self):
        """Connect to Redis."""
        self.redis = redis.from_url(self.redis_url, decode_responses=True)

    async def disconnect(self):
        """Disconnect from Redis."""
        if self.redis:
            await self.redis.close()

    async def start(self):
        """Start the scheduler loop."""
        await self.connect()
        self.running = True
        asyncio.create_task(self._scheduler_loop())
        asyncio.create_task(self._node_monitor_loop())

    async def stop(self):
        """Stop the scheduler."""
        self.running = False
        await self.disconnect()

    # === Node Management ===

    async def register_node(self, node: VisionNode):
        """Register or update a node."""
        async with self._lock:
            self.nodes[node.node_id] = node
            await self.redis.hset(
                NODE_STATUS_KEY,
                node.node_id,
                json.dumps(asdict(node))
            )

    async def update_node_heartbeat(
        self,
        node_id: str,
        current_model: Optional[str] = None,
        gpu_util: int = 0,
        status: str = "online"
    ):
        """Update node heartbeat and status."""
        async with self._lock:
            if node_id in self.nodes:
                node = self.nodes[node_id]
                node.last_heartbeat = time.time()
                node.gpu_util = gpu_util
                node.status = status
                if current_model:
                    node.current_model = current_model
                await self.redis.hset(
                    NODE_STATUS_KEY,
                    node_id,
                    json.dumps(asdict(node))
                )

    async def get_nodes(self) -> List[VisionNode]:
        """Get all registered nodes."""
        return list(self.nodes.values())

    async def get_available_nodes(self, model: Optional[str] = None) -> List[VisionNode]:
        """Get nodes available for work, optionally filtered by model."""
        nodes = []
        for node in self.nodes.values():
            if node.is_available:
                if model is None or node.current_model == model:
                    nodes.append(node)
        return nodes

    # === Queue Management ===

    async def enqueue_job(self, job: QueueJob) -> str:
        """Add a job to the queue."""
        job_data = {
            "job_id": job.job_id,
            "request_data": job.request_data,
            "target_model": job.target_model,
            "status": job.status.value,
            "assigned_node": job.assigned_node,
            "created_at": job.created_at,
            "started_at": job.started_at,
            "completed_at": job.completed_at,
            "result": job.result,
            "error": job.error,
            "priority": job.priority,
        }
        await self.redis.lpush(QUEUE_KEY, json.dumps(job_data))
        return job.job_id

    async def get_queue_length(self) -> int:
        """Get number of jobs in queue."""
        return await self.redis.llen(QUEUE_KEY)

    async def get_queue_jobs(self, limit: int = 50) -> List[Dict]:
        """Get jobs from queue."""
        jobs_raw = await self.redis.lrange(QUEUE_KEY, 0, limit - 1)
        return [json.loads(j) for j in jobs_raw]

    async def get_next_job(self) -> Optional[QueueJob]:
        """Get the next job from queue (FIFO with priority)."""
        job_raw = await self.redis.rpop(QUEUE_KEY)
        if not job_raw:
            return None
        job_data = json.loads(job_raw)
        return QueueJob(
            job_id=job_data["job_id"],
            request_data=job_data["request_data"],
            target_model=job_data["target_model"],
            status=JobStatus(job_data["status"]),
            assigned_node=job_data.get("assigned_node"),
            created_at=job_data["created_at"],
            priority=job_data.get("priority", 0),
        )

    # === Smart Routing ===

    async def find_best_node_for_job(self, job: QueueJob) -> Optional[VisionNode]:
        """
        Find the best node to handle a job.

        Priority:
        1. Available node with matching model already loaded
        2. Any available node (will need model switch)
        3. None if all nodes are busy
        """
        target_model = job.target_model

        # First: Find available node with matching model
        matching_nodes = await self.get_available_nodes(model=target_model)
        if matching_nodes:
            # Return node with lowest GPU utilization
            return min(matching_nodes, key=lambda n: n.gpu_util)

        # Second: Find any available node (will need model switch)
        available_nodes = await self.get_available_nodes()
        if available_nodes:
            # Prefer node that's been idle longest (hasn't switched recently)
            return min(available_nodes, key=lambda n: n.gpu_util)

        # All nodes busy
        return None

    async def switch_node_model(self, node: VisionNode, new_model: str) -> bool:
        """
        Request a node to switch its loaded model.

        Returns True if switch was initiated successfully.
        """
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(
                    f"http://{node.ip}:{node.port}/models/switch",
                    json={"model_name": new_model}
                )
                if response.status_code == 200:
                    # Update node status
                    node.status = "switching"
                    node.current_model = None
                    await self.register_node(node)
                    return True
                return False
        except Exception as e:
            print(f"Failed to switch model on {node.hostname}: {e}")
            return False

    async def dispatch_job_to_node(self, job: QueueJob, node: VisionNode) -> bool:
        """
        Dispatch a job to a specific node.
        """
        try:
            async with httpx.AsyncClient(timeout=300.0) as client:
                # Mark node as busy
                node.status = "busy"
                node.current_job_id = job.job_id
                await self.register_node(node)

                # Send generation request
                response = await client.post(
                    f"http://{node.ip}:{node.port}/generate",
                    json=job.request_data
                )

                result = response.json()

                # Update job status
                job.status = JobStatus.COMPLETED if response.status_code == 200 else JobStatus.FAILED
                job.completed_at = time.time()
                job.result = result

                # Mark node as available
                node.status = "online"
                node.current_job_id = None
                await self.register_node(node)

                return response.status_code == 200

        except Exception as e:
            print(f"Failed to dispatch job {job.job_id} to {node.hostname}: {e}")
            job.status = JobStatus.FAILED
            job.error = str(e)
            node.status = "online"
            node.current_job_id = None
            await self.register_node(node)
            return False

    # === Main Scheduler Loop ===

    async def _scheduler_loop(self):
        """Main scheduling loop."""
        while self.running:
            try:
                # Check for pending jobs
                job = await self.get_next_job()
                if not job:
                    await asyncio.sleep(0.5)
                    continue

                # Find best node for this job
                node = await self.find_best_node_for_job(job)

                if not node:
                    # No available nodes - put job back in queue
                    await self.enqueue_job(job)
                    await asyncio.sleep(1)
                    continue

                # Check if model switch is needed
                if node.current_model != job.target_model:
                    job.status = JobStatus.MODEL_SWITCHING
                    success = await self.switch_node_model(node, job.target_model)
                    if not success:
                        job.status = JobStatus.FAILED
                        job.error = "Failed to switch model"
                        continue
                    # Wait for model to load
                    await self._wait_for_model_load(node, job.target_model)

                # Dispatch job
                job.status = JobStatus.RUNNING
                job.assigned_node = node.node_id
                job.started_at = time.time()

                # Run dispatch in background to not block scheduler
                asyncio.create_task(self.dispatch_job_to_node(job, node))

            except Exception as e:
                print(f"Scheduler error: {e}")
                await asyncio.sleep(1)

    async def _wait_for_model_load(self, node: VisionNode, target_model: str, timeout: int = 120):
        """Wait for a node to finish loading a model."""
        start = time.time()
        while time.time() - start < timeout:
            await asyncio.sleep(2)
            # Check node status
            if node.current_model == target_model and node.status == "online":
                return True
        return False

    async def _node_monitor_loop(self):
        """Monitor node health and update statuses."""
        while self.running:
            try:
                # Load nodes from Redis (in case of restart)
                nodes_data = await self.redis.hgetall(NODE_STATUS_KEY)
                for node_id, node_json in nodes_data.items():
                    node_data = json.loads(node_json)
                    if node_id not in self.nodes:
                        self.nodes[node_id] = VisionNode(**node_data)

                # Check for stale nodes
                for node in self.nodes.values():
                    if not node.is_online and node.status != "offline":
                        node.status = "offline"
                        await self.register_node(node)

                await asyncio.sleep(5)

            except Exception as e:
                print(f"Node monitor error: {e}")
                await asyncio.sleep(5)


# Global scheduler instance
scheduler: Optional[SmartScheduler] = None


async def get_scheduler() -> SmartScheduler:
    """Get or create the global scheduler instance."""
    global scheduler
    if scheduler is None:
        scheduler = SmartScheduler()
        await scheduler.start()
    return scheduler


async def get_cluster_status() -> Dict[str, Any]:
    """Get current cluster status for API."""
    s = await get_scheduler()
    nodes = await s.get_nodes()
    queue_length = await s.get_queue_length()

    # Count by status
    online = sum(1 for n in nodes if n.status == "online")
    busy = sum(1 for n in nodes if n.status == "busy")
    switching = sum(1 for n in nodes if n.status == "switching")
    offline = sum(1 for n in nodes if n.status == "offline")

    # Models loaded
    models_loaded = {}
    for n in nodes:
        if n.current_model:
            if n.current_model not in models_loaded:
                models_loaded[n.current_model] = []
            models_loaded[n.current_model].append(n.hostname)

    return {
        "nodes": {
            "total": len(nodes),
            "online": online,
            "busy": busy,
            "switching": switching,
            "offline": offline,
        },
        "queue": {
            "pending": queue_length,
        },
        "models_loaded": models_loaded,
        "nodes_detail": [asdict(n) for n in nodes],
    }
