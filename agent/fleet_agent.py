#!/usr/bin/env python3
"""
Fleet Agent - Runs on each GPU node to report metrics and execute commands.

This agent:
- Registers with the Fleet Commander API on startup
- Sends heartbeats with GPU/system metrics every second
- Executes commands sent from the central API
- Reports container status and health
"""

import asyncio
import json
import os
import socket
import subprocess
import time
from dataclasses import dataclass, asdict
from datetime import datetime
from typing import Optional, Dict, Any, List
import httpx
import redis.asyncio as redis


@dataclass
class GPUMetrics:
    index: int
    name: str
    temperature: int
    utilization: int
    memory_used: int
    memory_total: int
    power_draw: float
    power_limit: float


@dataclass
class SystemMetrics:
    hostname: str
    ip_address: str
    cpu_percent: float
    memory_percent: float
    disk_percent: float
    disk_free_gb: float
    uptime_seconds: int
    load_average: List[float]


@dataclass
class ContainerInfo:
    id: str
    name: str
    image: str
    status: str
    state: str
    created: str
    ports: Dict[str, Any]


class FleetAgent:
    def __init__(
        self,
        api_url: str = None,
        redis_url: str = None,
        node_id: str = None,
        cluster: str = "default",
        heartbeat_interval: float = 1.0,
    ):
        self.api_url = api_url or os.getenv("FLEET_API_URL", "http://192.168.1.214:8765")
        self.redis_url = redis_url or os.getenv("REDIS_URL", "redis://192.168.1.214:6379")
        self.node_id = node_id or os.getenv("NODE_ID") or socket.gethostname()
        self.cluster = cluster or os.getenv("CLUSTER", "default")
        self.heartbeat_interval = heartbeat_interval

        self.redis: Optional[redis.Redis] = None
        self.http_client: Optional[httpx.AsyncClient] = None
        self.running = False
        self.registered = False

        # Cached system info
        self._gpu_count = 0
        self._gpu_names = []
        self._detect_gpus()

    def _detect_gpus(self):
        """Detect available GPUs."""
        try:
            result = subprocess.run(
                ["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"],
                capture_output=True, text=True, timeout=10
            )
            if result.returncode == 0:
                self._gpu_names = [name.strip() for name in result.stdout.strip().split('\n') if name.strip()]
                self._gpu_count = len(self._gpu_names)
        except Exception as e:
            print(f"No NVIDIA GPUs detected: {e}")
            self._gpu_count = 0
            self._gpu_names = []

    async def connect(self):
        """Connect to Redis and HTTP client."""
        self.redis = redis.from_url(self.redis_url, decode_responses=True)
        self.http_client = httpx.AsyncClient(timeout=30.0)
        print(f"Agent connected - Node: {self.node_id}, Cluster: {self.cluster}")

    async def disconnect(self):
        """Disconnect from services."""
        if self.redis:
            await self.redis.close()
        if self.http_client:
            await self.http_client.aclose()

    async def register(self) -> bool:
        """Register this agent with the Fleet Commander API."""
        try:
            registration_data = {
                "node_id": self.node_id,
                "cluster": self.cluster,
                "hostname": socket.gethostname(),
                "ip_address": self._get_ip_address(),
                "gpu_count": self._gpu_count,
                "gpu_names": self._gpu_names,
                "agent_version": "1.0.0",
                "capabilities": self._get_capabilities(),
            }

            response = await self.http_client.post(
                f"{self.api_url}/api/agents/register",
                json=registration_data
            )

            if response.status_code == 200:
                self.registered = True
                print(f"Agent registered successfully: {self.node_id}")
                return True
            else:
                print(f"Registration failed: {response.status_code} - {response.text}")
                return False

        except Exception as e:
            print(f"Registration error: {e}")
            return False

    def _get_ip_address(self) -> str:
        """Get the primary IP address."""
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("8.8.8.8", 80))
            ip = s.getsockname()[0]
            s.close()
            return ip
        except:
            return "127.0.0.1"

    def _get_capabilities(self) -> List[str]:
        """Get node capabilities."""
        caps = ["docker", "metrics"]
        if self._gpu_count > 0:
            caps.extend(["gpu", "cuda", "tensorrt"])
        return caps

    def get_gpu_metrics(self) -> List[GPUMetrics]:
        """Get current GPU metrics from nvidia-smi."""
        if self._gpu_count == 0:
            return []

        try:
            result = subprocess.run(
                [
                    "nvidia-smi",
                    "--query-gpu=index,name,temperature.gpu,utilization.gpu,memory.used,memory.total,power.draw,power.limit",
                    "--format=csv,noheader,nounits"
                ],
                capture_output=True, text=True, timeout=10
            )

            if result.returncode != 0:
                return []

            metrics = []
            for line in result.stdout.strip().split('\n'):
                if not line.strip():
                    continue
                parts = [p.strip() for p in line.split(',')]
                if len(parts) >= 8:
                    metrics.append(GPUMetrics(
                        index=int(parts[0]),
                        name=parts[1],
                        temperature=int(parts[2]),
                        utilization=int(parts[3]),
                        memory_used=int(parts[4]),
                        memory_total=int(parts[5]),
                        power_draw=float(parts[6]) if parts[6] != '[N/A]' else 0,
                        power_limit=float(parts[7]) if parts[7] != '[N/A]' else 0,
                    ))
            return metrics

        except Exception as e:
            print(f"Error getting GPU metrics: {e}")
            return []

    def get_system_metrics(self) -> SystemMetrics:
        """Get current system metrics."""
        import shutil

        # CPU usage
        try:
            with open('/proc/stat', 'r') as f:
                cpu_line = f.readline()
            cpu_parts = cpu_line.split()[1:5]
            cpu_total = sum(int(x) for x in cpu_parts)
            cpu_idle = int(cpu_parts[3])
            cpu_percent = 100 * (1 - cpu_idle / cpu_total) if cpu_total > 0 else 0
        except:
            cpu_percent = 0

        # Memory usage
        try:
            with open('/proc/meminfo', 'r') as f:
                lines = f.readlines()
            mem_info = {}
            for line in lines:
                parts = line.split()
                if len(parts) >= 2:
                    mem_info[parts[0].rstrip(':')] = int(parts[1])
            mem_total = mem_info.get('MemTotal', 1)
            mem_available = mem_info.get('MemAvailable', mem_info.get('MemFree', 0))
            memory_percent = 100 * (1 - mem_available / mem_total)
        except:
            memory_percent = 0

        # Disk usage
        try:
            disk = shutil.disk_usage('/')
            disk_percent = 100 * (disk.used / disk.total)
            disk_free_gb = disk.free / (1024 ** 3)
        except:
            disk_percent = 0
            disk_free_gb = 0

        # Uptime
        try:
            with open('/proc/uptime', 'r') as f:
                uptime_seconds = int(float(f.read().split()[0]))
        except:
            uptime_seconds = 0

        # Load average
        try:
            load_average = list(os.getloadavg())
        except:
            load_average = [0.0, 0.0, 0.0]

        return SystemMetrics(
            hostname=socket.gethostname(),
            ip_address=self._get_ip_address(),
            cpu_percent=round(cpu_percent, 1),
            memory_percent=round(memory_percent, 1),
            disk_percent=round(disk_percent, 1),
            disk_free_gb=round(disk_free_gb, 2),
            uptime_seconds=uptime_seconds,
            load_average=load_average,
        )

    def get_containers(self) -> List[ContainerInfo]:
        """Get running Docker containers."""
        try:
            result = subprocess.run(
                ["docker", "ps", "-a", "--format", "{{json .}}"],
                capture_output=True, text=True, timeout=30
            )

            if result.returncode != 0:
                return []

            containers = []
            for line in result.stdout.strip().split('\n'):
                if not line.strip():
                    continue
                try:
                    data = json.loads(line)
                    containers.append(ContainerInfo(
                        id=data.get('ID', ''),
                        name=data.get('Names', ''),
                        image=data.get('Image', ''),
                        status=data.get('Status', ''),
                        state=data.get('State', ''),
                        created=data.get('CreatedAt', ''),
                        ports=data.get('Ports', ''),
                    ))
                except json.JSONDecodeError:
                    continue
            return containers

        except Exception as e:
            print(f"Error getting containers: {e}")
            return []

    async def send_heartbeat(self):
        """Send heartbeat with current metrics to Redis."""
        gpu_metrics = self.get_gpu_metrics()
        system_metrics = self.get_system_metrics()
        containers = self.get_containers()

        heartbeat = {
            "node_id": self.node_id,
            "cluster": self.cluster,
            "timestamp": datetime.utcnow().isoformat(),
            "status": "online",
            "system": asdict(system_metrics),
            "gpus": [asdict(g) for g in gpu_metrics],
            "containers": [asdict(c) for c in containers],
        }

        try:
            # Store in Redis with TTL
            key = f"agent:heartbeat:{self.node_id}"
            await self.redis.set(key, json.dumps(heartbeat), ex=30)

            # Publish to channel for real-time updates
            await self.redis.publish(f"metrics:{self.node_id}", json.dumps(heartbeat))

            # Add to active agents set
            await self.redis.sadd("agents:active", self.node_id)

            # Store metrics in stream for history
            await self.redis.xadd(
                f"stream:metrics:{self.node_id}",
                {"data": json.dumps(heartbeat)},
                maxlen=3600  # Keep 1 hour at 1/sec
            )

        except Exception as e:
            print(f"Error sending heartbeat: {e}")

    async def listen_for_commands(self):
        """Listen for commands from the central API via Redis pubsub."""
        pubsub = self.redis.pubsub()
        await pubsub.subscribe(f"commands:{self.node_id}")

        async for message in pubsub.listen():
            if message['type'] != 'message':
                continue

            try:
                command = json.loads(message['data'])
                await self.execute_command(command)
            except Exception as e:
                print(f"Error processing command: {e}")

    async def execute_command(self, command: Dict[str, Any]):
        """Execute a command received from the central API."""
        cmd_type = command.get('type')
        cmd_id = command.get('id', 'unknown')

        print(f"Executing command {cmd_id}: {cmd_type}")

        result = {
            "command_id": cmd_id,
            "node_id": self.node_id,
            "timestamp": datetime.utcnow().isoformat(),
            "success": False,
            "output": "",
            "error": "",
        }

        try:
            if cmd_type == "shell":
                # Execute shell command
                shell_cmd = command.get('command', '')
                proc = await asyncio.create_subprocess_shell(
                    shell_cmd,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE
                )
                stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=300)
                result['success'] = proc.returncode == 0
                result['output'] = stdout.decode()
                result['error'] = stderr.decode()

            elif cmd_type == "docker_run":
                # Run a Docker container
                image = command.get('image')
                name = command.get('name')
                opts = command.get('options', '')
                cmd = f"docker run -d --name {name} {opts} {image}"
                proc = await asyncio.create_subprocess_shell(
                    cmd,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE
                )
                stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=120)
                result['success'] = proc.returncode == 0
                result['output'] = stdout.decode()
                result['error'] = stderr.decode()

            elif cmd_type == "docker_stop":
                # Stop a container
                container = command.get('container')
                proc = await asyncio.create_subprocess_shell(
                    f"docker stop {container}",
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE
                )
                stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=60)
                result['success'] = proc.returncode == 0
                result['output'] = stdout.decode()
                result['error'] = stderr.decode()

            elif cmd_type == "docker_logs":
                # Get container logs
                container = command.get('container')
                tail = command.get('tail', 100)
                proc = await asyncio.create_subprocess_shell(
                    f"docker logs --tail {tail} {container}",
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE
                )
                stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=30)
                result['success'] = True
                result['output'] = stdout.decode() + stderr.decode()

            elif cmd_type == "ping":
                result['success'] = True
                result['output'] = "pong"

            else:
                result['error'] = f"Unknown command type: {cmd_type}"

        except asyncio.TimeoutError:
            result['error'] = "Command timed out"
        except Exception as e:
            result['error'] = str(e)

        # Send result back via Redis
        await self.redis.publish(f"command_results:{cmd_id}", json.dumps(result))
        await self.redis.set(f"command:result:{cmd_id}", json.dumps(result), ex=3600)

    async def heartbeat_loop(self):
        """Main heartbeat loop."""
        while self.running:
            await self.send_heartbeat()
            await asyncio.sleep(self.heartbeat_interval)

    async def run(self):
        """Run the agent."""
        await self.connect()

        # Try to register (retry if fails)
        for attempt in range(5):
            if await self.register():
                break
            print(f"Registration attempt {attempt + 1} failed, retrying in 5s...")
            await asyncio.sleep(5)

        self.running = True

        # Run heartbeat and command listener concurrently
        await asyncio.gather(
            self.heartbeat_loop(),
            self.listen_for_commands(),
        )

    def stop(self):
        """Stop the agent."""
        self.running = False


async def main():
    """Main entry point."""
    agent = FleetAgent(
        node_id=os.getenv("NODE_ID"),
        cluster=os.getenv("CLUSTER", "vision"),
        heartbeat_interval=float(os.getenv("HEARTBEAT_INTERVAL", "1.0")),
    )

    try:
        await agent.run()
    except KeyboardInterrupt:
        print("Shutting down agent...")
        agent.stop()
    finally:
        await agent.disconnect()


if __name__ == "__main__":
    asyncio.run(main())
