#!/usr/bin/env python3
"""
Fleet Agent for Windows GPU Nodes - Full Control Edition
GPU access, Docker management, command execution from Fleet Commander
"""

import os
import sys
import json
import time
import socket
import platform
import subprocess
import threading
from datetime import datetime
from typing import Dict, Any, Optional, List
from http.server import HTTPServer, BaseHTTPRequestHandler
import urllib.parse

import requests
import psutil

try:
    from minio import Minio
    from minio.error import S3Error
    MINIO_AVAILABLE = True
except ImportError:
    MINIO_AVAILABLE = False
    print("Warning: minio package not installed, S3 sync disabled")

# Configuration
FLEET_COMMANDER_URL = os.environ.get("FLEET_COMMANDER_URL", "http://192.168.1.214:8765")
NODE_ID = os.environ.get("NODE_ID", socket.gethostname())
REPORT_INTERVAL = int(os.environ.get("REPORT_INTERVAL", "10"))
CLUSTER = os.environ.get("CLUSTER", "windows")
AGENT_PORT = int(os.environ.get("AGENT_PORT", "9100"))

# MinIO/S3 Configuration
MINIO_ENDPOINT = os.environ.get("MINIO_ENDPOINT", "192.168.1.214:9010")
MINIO_ACCESS_KEY = os.environ.get("MINIO_ACCESS_KEY", "minioadmin")
MINIO_SECRET_KEY = os.environ.get("MINIO_SECRET_KEY", "minioadmin123")
MINIO_MODELS_BUCKET = os.environ.get("MINIO_MODELS_BUCKET", "fleet-models")
MINIO_OUTPUTS_BUCKET = os.environ.get("MINIO_OUTPUTS_BUCKET", "fleet-outputs")
MINIO_LORAS_BUCKET = os.environ.get("MINIO_LORAS_BUCKET", "fleet-loras")
AUTO_SYNC_MODELS = os.environ.get("AUTO_SYNC_MODELS", "true").lower() == "true"
SYNC_INTERVAL = int(os.environ.get("SYNC_INTERVAL", "300"))

# Local paths
MODELS_PATH = "/models"
OUTPUTS_PATH = "/outputs"
LORAS_PATH = "/loras"

# MinIO client
minio_client = None

print(f"""
╔═══════════════════════════════════════════════════════════╗
║      Fleet Agent for Windows GPU Nodes (Full Control)     ║
╠═══════════════════════════════════════════════════════════╣
║  Node ID: {NODE_ID:<47} ║
║  Fleet Commander: {FLEET_COMMANDER_URL:<39} ║
║  Cluster: {CLUSTER:<47} ║
║  Agent Port: {AGENT_PORT:<44} ║
╚═══════════════════════════════════════════════════════════╝
""")


class AgentHandler(BaseHTTPRequestHandler):
    """HTTP handler for receiving commands from Fleet Commander"""

    def log_message(self, format, *args):
        print(f"[API] {args[0]}")

    def send_json(self, data: dict, status: int = 200):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)

        if parsed.path == "/health":
            self.send_json({"status": "healthy", "node_id": NODE_ID})

        elif parsed.path == "/metrics":
            metrics = get_system_metrics()
            self.send_json(metrics)

        elif parsed.path == "/gpu":
            gpu_info = get_gpu_info()
            self.send_json(gpu_info)

        elif parsed.path == "/containers":
            containers = get_docker_containers()
            self.send_json({"containers": containers})

        elif parsed.path == "/docker/images":
            images = get_docker_images()
            self.send_json({"images": images})

        elif parsed.path == "/s3/status":
            self.send_json({
                "connected": minio_client is not None,
                "endpoint": MINIO_ENDPOINT,
                "models_bucket": MINIO_MODELS_BUCKET,
                "outputs_bucket": MINIO_OUTPUTS_BUCKET,
                "loras_bucket": MINIO_LORAS_BUCKET,
                "auto_sync": AUTO_SYNC_MODELS
            })

        elif parsed.path == "/s3/models":
            result = list_s3_bucket(MINIO_MODELS_BUCKET)
            self.send_json(result)

        elif parsed.path == "/s3/loras":
            result = list_s3_bucket(MINIO_LORAS_BUCKET)
            self.send_json(result)

        elif parsed.path == "/s3/outputs":
            result = list_s3_bucket(MINIO_OUTPUTS_BUCKET)
            self.send_json(result)

        else:
            self.send_json({"error": "Not found", "endpoints": [
                "/health", "/metrics", "/gpu", "/containers", "/docker/images",
                "/s3/status", "/s3/models", "/s3/loras", "/s3/outputs"
            ]}, 404)

    def do_POST(self):
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length).decode() if content_length else "{}"

        try:
            data = json.loads(body) if body else {}
        except:
            data = {}

        parsed = urllib.parse.urlparse(self.path)

        if parsed.path == "/exec":
            command = data.get("command", "")
            timeout = data.get("timeout", 60)
            result = execute_command(command, timeout)
            self.send_json(result)

        elif parsed.path == "/docker/run":
            result = docker_run(data)
            self.send_json(result)

        elif parsed.path == "/docker/stop":
            container = data.get("container", "")
            result = docker_stop(container)
            self.send_json(result)

        elif parsed.path == "/docker/rm":
            container = data.get("container", "")
            force = data.get("force", True)
            result = docker_rm(container, force)
            self.send_json(result)

        elif parsed.path == "/docker/pull":
            image = data.get("image", "")
            result = docker_pull(image)
            self.send_json(result)

        elif parsed.path == "/docker/logs":
            container = data.get("container", "")
            tail = data.get("tail", 100)
            result = docker_logs(container, tail)
            self.send_json(result)

        elif parsed.path == "/docker/restart":
            container = data.get("container", "")
            result = docker_restart(container)
            self.send_json(result)

        elif parsed.path == "/s3/sync":
            # Trigger manual sync
            direction = data.get("direction", "pull")  # pull or push
            bucket = data.get("bucket", MINIO_MODELS_BUCKET)
            local_path = data.get("local_path", MODELS_PATH)

            if direction == "pull":
                result = sync_from_s3(bucket, local_path)
            else:
                result = sync_to_s3(local_path, bucket)
            self.send_json(result)

        elif parsed.path == "/s3/download":
            bucket = data.get("bucket", MINIO_MODELS_BUCKET)
            object_name = data.get("object", "")
            local_path = data.get("local_path")
            result = download_model(bucket, object_name, local_path)
            self.send_json(result)

        elif parsed.path == "/s3/upload":
            bucket = data.get("bucket", MINIO_OUTPUTS_BUCKET)
            local_path = data.get("local_path", "")
            object_name = data.get("object", os.path.basename(local_path))
            if os.path.exists(local_path) and minio_client:
                try:
                    minio_client.fput_object(bucket, object_name, local_path)
                    self.send_json({"success": True, "uploaded": object_name})
                except Exception as e:
                    self.send_json({"success": False, "error": str(e)})
            else:
                self.send_json({"success": False, "error": "File not found or MinIO not connected"})

        else:
            self.send_json({"error": "Not found"}, 404)


def execute_command(command: str, timeout: int = 60) -> Dict[str, Any]:
    """Execute a shell command"""
    try:
        result = subprocess.run(
            command, shell=True,
            capture_output=True, text=True, timeout=timeout
        )
        return {
            "success": result.returncode == 0,
            "stdout": result.stdout,
            "stderr": result.stderr,
            "exit_code": result.returncode
        }
    except subprocess.TimeoutExpired:
        return {"success": False, "error": "Command timed out"}
    except Exception as e:
        return {"success": False, "error": str(e)}


def docker_run(config: Dict[str, Any]) -> Dict[str, Any]:
    """Run a Docker container with GPU support"""
    try:
        cmd = ["docker", "run", "-d"]

        if config.get("name"):
            cmd.extend(["--name", config["name"]])

        # GPU support - always enable for Windows GPU nodes
        if config.get("gpu", True):
            cmd.extend(["--gpus", "all"])

        cmd.extend(["--restart", config.get("restart", "unless-stopped")])

        for port in config.get("ports", []):
            cmd.extend(["-p", port])

        for env in config.get("env", []):
            cmd.extend(["-e", env])

        for vol in config.get("volumes", []):
            cmd.extend(["-v", vol])

        # Resource limits
        if config.get("memory"):
            cmd.extend(["--memory", config["memory"]])

        cmd.append(config.get("image", ""))

        if config.get("command"):
            cmd.extend(config["command"].split())

        print(f"[Docker] Running: {' '.join(cmd)}")
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)

        return {
            "success": result.returncode == 0,
            "container_id": result.stdout.strip()[:12] if result.returncode == 0 else None,
            "stdout": result.stdout,
            "stderr": result.stderr
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


def docker_stop(container: str) -> Dict[str, Any]:
    """Stop a Docker container"""
    try:
        result = subprocess.run(
            ["docker", "stop", container],
            capture_output=True, text=True, timeout=30
        )
        return {"success": result.returncode == 0, "output": result.stdout.strip()}
    except Exception as e:
        return {"success": False, "error": str(e)}


def docker_rm(container: str, force: bool = True) -> Dict[str, Any]:
    """Remove a Docker container"""
    try:
        cmd = ["docker", "rm"]
        if force:
            cmd.append("-f")
        cmd.append(container)
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        return {"success": result.returncode == 0, "output": result.stdout.strip()}
    except Exception as e:
        return {"success": False, "error": str(e)}


def docker_restart(container: str) -> Dict[str, Any]:
    """Restart a Docker container"""
    try:
        result = subprocess.run(
            ["docker", "restart", container],
            capture_output=True, text=True, timeout=60
        )
        return {"success": result.returncode == 0, "output": result.stdout.strip()}
    except Exception as e:
        return {"success": False, "error": str(e)}


def docker_pull(image: str) -> Dict[str, Any]:
    """Pull a Docker image"""
    try:
        print(f"[Docker] Pulling: {image}")
        result = subprocess.run(
            ["docker", "pull", image],
            capture_output=True, text=True, timeout=600
        )
        return {"success": result.returncode == 0, "output": result.stdout}
    except Exception as e:
        return {"success": False, "error": str(e)}


def docker_logs(container: str, tail: int = 100) -> Dict[str, Any]:
    """Get Docker container logs"""
    try:
        result = subprocess.run(
            ["docker", "logs", "--tail", str(tail), container],
            capture_output=True, text=True, timeout=30
        )
        return {
            "success": result.returncode == 0,
            "logs": result.stdout + result.stderr
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


def get_docker_images() -> List[Dict[str, Any]]:
    """Get Docker images"""
    try:
        result = subprocess.run(
            ["docker", "images", "--format", "{{.Repository}}:{{.Tag}}|{{.Size}}|{{.ID}}"],
            capture_output=True, text=True, timeout=30
        )
        images = []
        if result.returncode == 0:
            for line in result.stdout.strip().split("\n"):
                if line:
                    parts = line.split("|")
                    images.append({
                        "name": parts[0],
                        "size": parts[1] if len(parts) > 1 else "",
                        "id": parts[2] if len(parts) > 2 else ""
                    })
        return images
    except:
        return []


def get_gpu_info() -> Dict[str, Any]:
    """Get NVIDIA GPU information"""
    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,memory.total,memory.used,memory.free,utilization.gpu,temperature.gpu,power.draw,power.limit",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=10
        )
        if result.returncode == 0:
            gpus = []
            for i, line in enumerate(result.stdout.strip().split("\n")):
                parts = [p.strip() for p in line.split(",")]
                if len(parts) >= 6:
                    gpus.append({
                        "index": i,
                        "name": parts[0],
                        "memory_total": int(float(parts[1])),
                        "memory_used": int(float(parts[2])),
                        "memory_free": int(float(parts[3])),
                        "utilization": int(float(parts[4])),
                        "temperature": int(float(parts[5])),
                        "power_draw": float(parts[6]) if len(parts) > 6 and parts[6] else 0,
                        "power_limit": float(parts[7]) if len(parts) > 7 and parts[7] else 0
                    })
            return {"gpus": gpus, "count": len(gpus), "available": True}
    except FileNotFoundError:
        return {"gpus": [], "count": 0, "available": False, "error": "nvidia-smi not found"}
    except Exception as e:
        return {"gpus": [], "count": 0, "available": False, "error": str(e)}


def get_docker_containers() -> List[Dict[str, Any]]:
    """Get all Docker containers"""
    try:
        result = subprocess.run(
            ["docker", "ps", "-a", "--format", "{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}|{{.ID}}"],
            capture_output=True, text=True, timeout=10
        )
        containers = []
        if result.returncode == 0:
            for line in result.stdout.strip().split("\n"):
                if line:
                    parts = line.split("|")
                    containers.append({
                        "name": parts[0],
                        "image": parts[1] if len(parts) > 1 else "",
                        "status": parts[2] if len(parts) > 2 else "",
                        "ports": parts[3] if len(parts) > 3 else "",
                        "id": parts[4] if len(parts) > 4 else ""
                    })
        return containers
    except:
        return []


def get_system_metrics() -> Dict[str, Any]:
    """Collect comprehensive system metrics"""
    try:
        cpu_percent = psutil.cpu_percent(interval=0.5)
        cpu_count = psutil.cpu_count()
        memory = psutil.virtual_memory()
        disk = psutil.disk_usage("C:\\" if platform.system() == "Windows" else "/")
        net = psutil.net_io_counters()
        gpu_info = get_gpu_info()
        containers = get_docker_containers()
        running = len([c for c in containers if "Up" in c.get("status", "")])

        return {
            "node_id": NODE_ID,
            "cluster": CLUSTER,
            "platform": platform.system().lower(),
            "hostname": socket.gethostname(),
            "ip": get_local_ip(),
            "agent_port": AGENT_PORT,
            "timestamp": datetime.utcnow().isoformat(),
            "cpu": cpu_percent,
            "memory": memory.percent,
            "disk": disk.percent,
            "gpu": gpu_info["gpus"][0]["utilization"] if gpu_info["gpus"] else 0,
            "gpu_memory": gpu_info["gpus"][0]["memory_used"] if gpu_info["gpus"] else 0,
            "temperature": gpu_info["gpus"][0]["temperature"] if gpu_info["gpus"] else 0,
            "gpu_info": gpu_info,
            "containers_running": running,
            "containers_total": len(containers),
            "status": "online"
        }
    except Exception as e:
        return {"node_id": NODE_ID, "status": "error", "error": str(e)}


def get_local_ip() -> str:
    """Get local IP address"""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except:
        return "127.0.0.1"


def report_metrics() -> bool:
    """Send metrics to Fleet Commander"""
    try:
        metrics = get_system_metrics()
        url = f"{FLEET_COMMANDER_URL}/api/nodes/heartbeat"
        response = requests.post(url, json=metrics, timeout=5)
        return response.status_code == 200
    except:
        return False


def init_minio_client():
    """Initialize MinIO client for S3 operations"""
    global minio_client
    if not MINIO_AVAILABLE:
        return None
    try:
        minio_client = Minio(
            MINIO_ENDPOINT,
            access_key=MINIO_ACCESS_KEY,
            secret_key=MINIO_SECRET_KEY,
            secure=False
        )
        # Test connection
        minio_client.list_buckets()
        print(f"✓ Connected to MinIO at {MINIO_ENDPOINT}")
        return minio_client
    except Exception as e:
        print(f"⚠ MinIO connection failed: {e}")
        return None


def sync_from_s3(bucket: str, local_path: str, prefix: str = "") -> Dict[str, Any]:
    """Sync files from S3 bucket to local directory"""
    if not minio_client:
        return {"success": False, "error": "MinIO not connected"}

    try:
        os.makedirs(local_path, exist_ok=True)
        synced = []
        skipped = []

        objects = minio_client.list_objects(bucket, prefix=prefix, recursive=True)
        for obj in objects:
            local_file = os.path.join(local_path, obj.object_name)
            local_dir = os.path.dirname(local_file)
            os.makedirs(local_dir, exist_ok=True)

            # Check if file exists and has same size
            if os.path.exists(local_file):
                local_size = os.path.getsize(local_file)
                if local_size == obj.size:
                    skipped.append(obj.object_name)
                    continue

            print(f"  Downloading: {obj.object_name} ({obj.size / 1024 / 1024:.1f}MB)")
            minio_client.fget_object(bucket, obj.object_name, local_file)
            synced.append(obj.object_name)

        return {
            "success": True,
            "synced": len(synced),
            "skipped": len(skipped),
            "files": synced
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


def sync_to_s3(local_path: str, bucket: str, prefix: str = "") -> Dict[str, Any]:
    """Sync files from local directory to S3 bucket"""
    if not minio_client:
        return {"success": False, "error": "MinIO not connected"}

    try:
        uploaded = []
        for root, dirs, files in os.walk(local_path):
            for file in files:
                local_file = os.path.join(root, file)
                rel_path = os.path.relpath(local_file, local_path)
                object_name = os.path.join(prefix, rel_path).replace("\\", "/")

                # Check if object exists with same size
                try:
                    stat = minio_client.stat_object(bucket, object_name)
                    if stat.size == os.path.getsize(local_file):
                        continue
                except:
                    pass

                print(f"  Uploading: {object_name}")
                minio_client.fput_object(bucket, object_name, local_file)
                uploaded.append(object_name)

        return {"success": True, "uploaded": len(uploaded), "files": uploaded}
    except Exception as e:
        return {"success": False, "error": str(e)}


def list_s3_bucket(bucket: str, prefix: str = "") -> Dict[str, Any]:
    """List files in S3 bucket"""
    if not minio_client:
        return {"success": False, "error": "MinIO not connected"}

    try:
        files = []
        objects = minio_client.list_objects(bucket, prefix=prefix, recursive=True)
        for obj in objects:
            files.append({
                "name": obj.object_name,
                "size": obj.size,
                "modified": obj.last_modified.isoformat() if obj.last_modified else None
            })
        return {"success": True, "files": files, "count": len(files)}
    except Exception as e:
        return {"success": False, "error": str(e)}


def download_model(bucket: str, object_name: str, local_path: str = None) -> Dict[str, Any]:
    """Download a specific model from S3"""
    if not minio_client:
        return {"success": False, "error": "MinIO not connected"}

    try:
        if not local_path:
            local_path = os.path.join(MODELS_PATH, object_name)

        local_dir = os.path.dirname(local_path)
        os.makedirs(local_dir, exist_ok=True)

        print(f"Downloading: {bucket}/{object_name} -> {local_path}")
        minio_client.fget_object(bucket, object_name, local_path)

        return {
            "success": True,
            "file": local_path,
            "size": os.path.getsize(local_path)
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


def sync_loop():
    """Background loop to sync models from S3"""
    global minio_client
    if not AUTO_SYNC_MODELS or not MINIO_AVAILABLE:
        return

    # Wait for initial startup
    time.sleep(30)

    while True:
        try:
            if not minio_client:
                minio_client = init_minio_client()

            if minio_client:
                print(f"\n[S3 Sync] Syncing models from {MINIO_ENDPOINT}...")

                # Sync models
                result = sync_from_s3(MINIO_MODELS_BUCKET, MODELS_PATH)
                if result["success"]:
                    print(f"  Models: {result['synced']} synced, {result['skipped']} skipped")

                # Sync loras
                result = sync_from_s3(MINIO_LORAS_BUCKET, LORAS_PATH)
                if result["success"]:
                    print(f"  LoRAs: {result['synced']} synced, {result['skipped']} skipped")

                # Upload outputs
                result = sync_to_s3(OUTPUTS_PATH, MINIO_OUTPUTS_BUCKET, prefix=NODE_ID)
                if result["success"] and result["uploaded"] > 0:
                    print(f"  Outputs: {result['uploaded']} uploaded")

        except Exception as e:
            print(f"[S3 Sync] Error: {e}")

        time.sleep(SYNC_INTERVAL)


def register_node() -> bool:
    """Register this node with Fleet Commander"""
    try:
        gpu_info = get_gpu_info()
        gpu_name = gpu_info["gpus"][0]["name"] if gpu_info["gpus"] else "No GPU"
        gpu_memory = gpu_info["gpus"][0]["memory_total"] if gpu_info["gpus"] else 0

        payload = {
            "node_id": NODE_ID,
            "hostname": socket.gethostname(),
            "ip": get_local_ip(),
            "platform": platform.system().lower(),
            "cluster": CLUSTER,
            "gpu_name": gpu_name,
            "gpu_memory_mb": gpu_memory,
            "gpu_count": gpu_info["count"],
            "agent_port": AGENT_PORT,
            "agent_version": "2.0.0",
            "capabilities": ["docker", "gpu", "exec", "pull", "run"]
        }

        url = f"{FLEET_COMMANDER_URL}/api/nodes/register"
        response = requests.post(url, json=payload, timeout=10)

        if response.status_code in [200, 201]:
            print(f"✓ Registered with Fleet Commander")
            print(f"  Node: {NODE_ID}")
            print(f"  GPU: {gpu_name} ({gpu_memory}MB)")
            print(f"  Agent API: http://{get_local_ip()}:{AGENT_PORT}")
            return True
        return False
    except Exception as e:
        print(f"Registration error: {e}")
        return False


def start_api_server():
    """Start the HTTP API server for Fleet Commander control"""
    server = HTTPServer(("0.0.0.0", AGENT_PORT), AgentHandler)
    print(f"✓ Agent API listening on port {AGENT_PORT}")
    print(f"  Endpoints: /health /metrics /gpu /containers /exec /docker/*")
    server.serve_forever()


def metrics_loop():
    """Background metrics reporting loop"""
    consecutive_failures = 0
    while True:
        try:
            success = report_metrics()
            if success:
                consecutive_failures = 0
            else:
                consecutive_failures += 1
                if consecutive_failures == 1 or consecutive_failures % 30 == 0:
                    print(f"⚠ Cannot reach Fleet Commander ({consecutive_failures} failures)")
            time.sleep(REPORT_INTERVAL)
        except Exception as e:
            time.sleep(REPORT_INTERVAL)


def main():
    """Main agent entry point"""
    global minio_client

    print("Starting Fleet Agent with Full Control...")
    print(f"Local IP: {get_local_ip()}")

    gpu_info = get_gpu_info()
    if gpu_info["gpus"]:
        for gpu in gpu_info["gpus"]:
            print(f"✓ GPU {gpu['index']}: {gpu['name']} ({gpu['memory_total']}MB)")
    else:
        print("⚠ No NVIDIA GPU detected")

    # Initialize MinIO connection
    print(f"\nConnecting to MinIO at {MINIO_ENDPOINT}...")
    minio_client = init_minio_client()

    print(f"\nConnecting to Fleet Commander at {FLEET_COMMANDER_URL}...")
    registered = False
    for attempt in range(10):
        registered = register_node()
        if registered:
            break
        print(f"  Retry {attempt+1}/10 in 5 seconds...")
        time.sleep(5)

    if not registered:
        print("⚠ Could not register, continuing anyway...")

    # Start metrics reporting in background
    metrics_thread = threading.Thread(target=metrics_loop, daemon=True)
    metrics_thread.start()

    # Start S3 sync loop in background
    if AUTO_SYNC_MODELS and MINIO_AVAILABLE:
        print(f"✓ S3 auto-sync enabled (every {SYNC_INTERVAL}s)")
        sync_thread = threading.Thread(target=sync_loop, daemon=True)
        sync_thread.start()

    # Start API server (blocking)
    print("\n" + "="*60)
    print("S3 Endpoints: /s3/status /s3/models /s3/sync /s3/download")
    start_api_server()


if __name__ == "__main__":
    main()
