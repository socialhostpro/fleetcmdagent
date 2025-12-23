"""
Node Benchmark API - Performance Testing for AGX Fleet

Benchmarks:
- GPU compute performance (matrix operations)
- Memory bandwidth
- Storage I/O
- Network throughput
"""
import asyncio
import asyncssh
import json
import uuid
from datetime import datetime
from typing import Optional, Dict, Any, List
from fastapi import APIRouter, HTTPException, BackgroundTasks
from pydantic import BaseModel
import redis.asyncio as redis
import os
from config import settings

router = APIRouter()
r = redis.from_url(settings.REDIS_URL, decode_responses=True)

# Default credentials
DEFAULT_USERNAME = os.getenv("JETSON_DEFAULT_USER", "jetson")
DEFAULT_PASSWORD = os.getenv("JETSON_DEFAULT_PASS", "jetson")


class BenchmarkRequest(BaseModel):
    node_ip: str
    tests: List[str] = ["gpu", "memory", "storage"]  # Available: gpu, memory, storage, network
    username: Optional[str] = None
    password: Optional[str] = None


class NetworkBenchmarkRequest(BaseModel):
    source_ip: str
    target_ip: str
    username: Optional[str] = None
    password: Optional[str] = None


async def get_credential(node_ip: str, username: str = None, password: str = None) -> Dict:
    """Get credential for a node."""
    creds = await r.hgetall("vault:credentials")
    for cred_json in creds.values():
        cred = json.loads(cred_json)
        if cred.get('host') == node_ip:
            return cred
    return {
        'username': username or DEFAULT_USERNAME,
        'password': password or DEFAULT_PASSWORD
    }


@router.post("/run")
async def run_benchmark(req: BenchmarkRequest, background_tasks: BackgroundTasks):
    """Start benchmark on a remote node."""
    task_id = str(uuid.uuid4())
    now = datetime.utcnow().isoformat()

    await r.hset(f"benchmark:{task_id}", mapping={
        "task_id": task_id,
        "node_ip": req.node_ip,
        "tests": json.dumps(req.tests),
        "status": "running",
        "started_at": now,
        "results": "{}",
        "log": "Starting benchmark..."
    })

    background_tasks.add_task(
        execute_benchmark, task_id, req.node_ip, req.tests,
        req.username, req.password
    )

    return {"task_id": task_id, "status": "started", "node_ip": req.node_ip}


@router.get("/status/{task_id}")
async def get_benchmark_status(task_id: str):
    """Get benchmark task status and results."""
    task = await r.hgetall(f"benchmark:{task_id}")
    if not task:
        raise HTTPException(status_code=404, detail="Benchmark task not found")

    return {
        "task_id": task.get("task_id"),
        "node_ip": task.get("node_ip"),
        "status": task.get("status"),
        "started_at": task.get("started_at"),
        "completed_at": task.get("completed_at"),
        "results": json.loads(task.get("results", "{}")),
        "log": task.get("log", ""),
        "error": task.get("error")
    }


@router.get("/history/{node_ip}")
async def get_benchmark_history(node_ip: str, limit: int = 10):
    """Get benchmark history for a node."""
    history_key = f"benchmark:history:{node_ip}"
    task_ids = await r.lrange(history_key, 0, limit - 1)

    history = []
    for tid in task_ids:
        task = await r.hgetall(f"benchmark:{tid}")
        if task:
            history.append({
                "task_id": tid,
                "status": task.get("status"),
                "started_at": task.get("started_at"),
                "results": json.loads(task.get("results", "{}"))
            })

    return history


@router.get("/compare")
async def compare_nodes(node_ips: str):
    """Compare benchmark results across multiple nodes."""
    ips = [ip.strip() for ip in node_ips.split(",")]
    comparison = {}

    for ip in ips:
        history_key = f"benchmark:history:{ip}"
        task_ids = await r.lrange(history_key, 0, 0)  # Get most recent
        if task_ids:
            task = await r.hgetall(f"benchmark:{task_ids[0]}")
            if task:
                comparison[ip] = json.loads(task.get("results", "{}"))

    return comparison


@router.post("/network")
async def run_network_benchmark(req: NetworkBenchmarkRequest, background_tasks: BackgroundTasks):
    """Run network throughput benchmark between two nodes."""
    task_id = str(uuid.uuid4())
    now = datetime.utcnow().isoformat()

    await r.hset(f"benchmark:{task_id}", mapping={
        "task_id": task_id,
        "source_ip": req.source_ip,
        "target_ip": req.target_ip,
        "status": "running",
        "started_at": now,
        "results": "{}",
        "log": "Starting network benchmark..."
    })

    background_tasks.add_task(
        execute_network_benchmark, task_id, req.source_ip, req.target_ip,
        req.username, req.password
    )

    return {"task_id": task_id, "status": "started"}


async def execute_benchmark(task_id: str, node_ip: str, tests: List[str],
                           username: str = None, password: str = None):
    """Execute benchmarks on a remote node."""
    cred = await get_credential(node_ip, username, password)
    logs = []
    results = {}

    try:
        async with asyncssh.connect(
            node_ip,
            username=cred['username'],
            password=cred['password'],
            known_hosts=None,
            connect_timeout=30
        ) as conn:
            sudo_prefix = f"echo '{cred['password']}' | sudo -S " if cred['username'] != 'root' else ""

            # Get system info first
            logs.append("=== System Information ===")
            sysinfo = await conn.run("cat /etc/nv_tegra_release 2>/dev/null || lsb_release -d 2>/dev/null || cat /etc/os-release | head -1", check=False)
            logs.append(f"OS: {sysinfo.stdout.strip() if sysinfo.stdout else 'Unknown'}")

            # GPU Info
            gpu_info = await conn.run("nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null || echo 'No NVIDIA GPU'", check=False)
            logs.append(f"GPU: {gpu_info.stdout.strip() if gpu_info.stdout else 'Unknown'}")

            # CPU Info
            cpu_info = await conn.run("lscpu | grep 'Model name' | cut -d':' -f2 | xargs", check=False)
            logs.append(f"CPU: {cpu_info.stdout.strip() if cpu_info.stdout else 'Unknown'}")

            # Memory Info
            mem_info = await conn.run("free -h | grep Mem | awk '{print $2}'", check=False)
            logs.append(f"Memory: {mem_info.stdout.strip() if mem_info.stdout else 'Unknown'}")

            await r.hset(f"benchmark:{task_id}", "log", "\n".join(logs))

            # === GPU Benchmark ===
            if "gpu" in tests:
                logs.append("\n=== GPU Compute Benchmark ===")
                await r.hset(f"benchmark:{task_id}", "log", "\n".join(logs))

                # Check if CUDA is available
                cuda_check = await conn.run("which nvcc || ls /usr/local/cuda/bin/nvcc 2>/dev/null", check=False)
                if cuda_check.exit_status == 0:
                    # Create and run a simple CUDA benchmark
                    bench_script = '''
import time
try:
    import torch
    if torch.cuda.is_available():
        device = torch.device("cuda")
        # Matrix multiplication benchmark
        sizes = [1024, 2048, 4096]
        results = {}
        for size in sizes:
            a = torch.randn(size, size, device=device)
            b = torch.randn(size, size, device=device)
            torch.cuda.synchronize()
            start = time.time()
            for _ in range(10):
                c = torch.matmul(a, b)
            torch.cuda.synchronize()
            elapsed = (time.time() - start) / 10
            gflops = (2 * size**3) / elapsed / 1e9
            results[f"{size}x{size}"] = {"time_ms": elapsed*1000, "gflops": gflops}
        print("GPU_RESULTS:" + str(results))
    else:
        print("GPU_RESULTS:{'error': 'CUDA not available'}")
except Exception as e:
    print(f"GPU_RESULTS:{{'error': '{str(e)}'}}")
'''
                    # Write benchmark script
                    await conn.run(f"cat > /tmp/gpu_bench.py << 'EOFBENCH'\n{bench_script}\nEOFBENCH", check=False)

                    # Run benchmark
                    gpu_result = await conn.run("python3 /tmp/gpu_bench.py 2>&1", check=False, timeout=120)
                    output = gpu_result.stdout if gpu_result.stdout else ""

                    if "GPU_RESULTS:" in output:
                        gpu_data = output.split("GPU_RESULTS:")[1].strip()
                        try:
                            results["gpu"] = eval(gpu_data)  # Safe since we control the input
                            logs.append(f"GPU Results: {results['gpu']}")
                        except:
                            results["gpu"] = {"raw": gpu_data}
                    else:
                        # Fallback to basic GPU query
                        gpu_util = await conn.run("nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader 2>/dev/null", check=False)
                        results["gpu"] = {"info": gpu_util.stdout.strip() if gpu_util.stdout else "Unable to benchmark"}
                        logs.append(f"GPU Info: {results['gpu']}")
                else:
                    logs.append("CUDA not found - skipping GPU benchmark")
                    results["gpu"] = {"status": "cuda_not_found"}

            # === Memory Benchmark ===
            if "memory" in tests:
                logs.append("\n=== Memory Benchmark ===")
                await r.hset(f"benchmark:{task_id}", "log", "\n".join(logs))

                # Use sysbench if available, otherwise use dd
                mem_bench = await conn.run("""
                if command -v sysbench &> /dev/null; then
                    sysbench memory run --memory-block-size=1M --memory-total-size=4G 2>/dev/null | grep -E "transferred|Operations"
                else
                    # Fallback: simple memory bandwidth test with dd
                    echo "Writing 1GB to /dev/null..."
                    dd if=/dev/zero of=/dev/null bs=1M count=1024 2>&1 | tail -1
                fi
                """, check=False, timeout=60)

                results["memory"] = {
                    "output": mem_bench.stdout.strip() if mem_bench.stdout else "Unable to benchmark"
                }
                logs.append(f"Memory: {results['memory']['output']}")

            # === Storage Benchmark ===
            if "storage" in tests:
                logs.append("\n=== Storage I/O Benchmark ===")
                await r.hset(f"benchmark:{task_id}", "log", "\n".join(logs))

                # Sequential write test
                write_test = await conn.run(f"""
                {sudo_prefix}bash -c '
                    TEST_FILE="/tmp/bench_test_$(date +%s)"
                    # Write test (512MB)
                    sync; echo 3 > /proc/sys/vm/drop_caches 2>/dev/null || true
                    WRITE=$(dd if=/dev/zero of=$TEST_FILE bs=1M count=512 conv=fdatasync 2>&1 | tail -1)
                    # Read test
                    sync; echo 3 > /proc/sys/vm/drop_caches 2>/dev/null || true
                    READ=$(dd if=$TEST_FILE of=/dev/null bs=1M 2>&1 | tail -1)
                    rm -f $TEST_FILE
                    echo "WRITE: $WRITE"
                    echo "READ: $READ"
                '
                """, check=False, timeout=120)

                storage_output = write_test.stdout.strip() if write_test.stdout else "Unable to benchmark"
                results["storage"] = {"output": storage_output}

                # Parse speeds if possible
                lines = storage_output.split('\n')
                for line in lines:
                    if 'WRITE:' in line and 'copied' in line:
                        # Extract speed like "536 MB/s"
                        import re
                        match = re.search(r'(\d+\.?\d*)\s*(MB|GB)/s', line)
                        if match:
                            results["storage"]["write_speed"] = f"{match.group(1)} {match.group(2)}/s"
                    elif 'READ:' in line and 'copied' in line:
                        match = re.search(r'(\d+\.?\d*)\s*(MB|GB)/s', line)
                        if match:
                            results["storage"]["read_speed"] = f"{match.group(1)} {match.group(2)}/s"

                logs.append(f"Storage: {results['storage']}")

            # Complete
            logs.append("\n=== Benchmark Complete ===")
            await r.hset(f"benchmark:{task_id}", mapping={
                "status": "completed",
                "results": json.dumps(results),
                "log": "\n".join(logs),
                "completed_at": datetime.utcnow().isoformat()
            })

            # Add to history
            await r.lpush(f"benchmark:history:{node_ip}", task_id)
            await r.ltrim(f"benchmark:history:{node_ip}", 0, 49)  # Keep last 50

    except asyncssh.PermissionDenied:
        await r.hset(f"benchmark:{task_id}", mapping={
            "status": "error",
            "error": "Permission denied - check credentials",
            "log": "\n".join(logs) + "\n\nError: Permission denied"
        })
    except asyncio.TimeoutError:
        await r.hset(f"benchmark:{task_id}", mapping={
            "status": "error",
            "error": "Connection timeout",
            "log": "\n".join(logs) + "\n\nError: Connection timeout"
        })
    except Exception as e:
        await r.hset(f"benchmark:{task_id}", mapping={
            "status": "error",
            "error": str(e),
            "log": "\n".join(logs) + f"\n\nError: {str(e)}"
        })


async def execute_network_benchmark(task_id: str, source_ip: str, target_ip: str,
                                    username: str = None, password: str = None):
    """Execute network throughput benchmark between two nodes."""
    cred = await get_credential(source_ip, username, password)
    logs = []
    results = {}

    try:
        async with asyncssh.connect(
            source_ip,
            username=cred['username'],
            password=cred['password'],
            known_hosts=None,
            connect_timeout=30
        ) as conn:
            logs.append(f"=== Network Benchmark: {source_ip} -> {target_ip} ===")

            # Check if iperf3 is installed
            iperf_check = await conn.run("which iperf3", check=False)

            if iperf_check.exit_status == 0:
                # Run iperf3 test
                logs.append("Running iperf3 test...")
                await r.hset(f"benchmark:{task_id}", "log", "\n".join(logs))

                # Try to connect to iperf server on target
                iperf_result = await conn.run(f"iperf3 -c {target_ip} -t 10 -J 2>&1", check=False, timeout=30)

                if iperf_result.exit_status == 0 and iperf_result.stdout:
                    try:
                        iperf_data = json.loads(iperf_result.stdout)
                        end_data = iperf_data.get("end", {})
                        sum_sent = end_data.get("sum_sent", {})
                        sum_received = end_data.get("sum_received", {})

                        results["iperf3"] = {
                            "sent_mbps": round(sum_sent.get("bits_per_second", 0) / 1e6, 2),
                            "received_mbps": round(sum_received.get("bits_per_second", 0) / 1e6, 2),
                            "retransmits": sum_sent.get("retransmits", 0)
                        }
                        logs.append(f"iperf3 Results: {results['iperf3']}")
                    except json.JSONDecodeError:
                        results["iperf3"] = {"raw": iperf_result.stdout}
                else:
                    logs.append(f"iperf3 failed or no server running on {target_ip}")
                    logs.append("Tip: Start iperf3 server on target with: iperf3 -s")
                    results["iperf3"] = {"error": "No iperf3 server or connection failed"}
            else:
                logs.append("iperf3 not installed - using ping test")

            # Ping test (always run)
            logs.append("Running ping test...")
            ping_result = await conn.run(f"ping -c 10 {target_ip}", check=False, timeout=30)

            if ping_result.stdout:
                # Parse ping output
                lines = ping_result.stdout.strip().split('\n')
                for line in lines:
                    if 'rtt' in line or 'round-trip' in line:
                        results["ping"] = {"stats": line}
                    elif 'packets transmitted' in line:
                        results["ping"] = results.get("ping", {})
                        results["ping"]["summary"] = line

            logs.append(f"Ping Results: {results.get('ping', 'N/A')}")
            logs.append("\n=== Network Benchmark Complete ===")

            await r.hset(f"benchmark:{task_id}", mapping={
                "status": "completed",
                "results": json.dumps(results),
                "log": "\n".join(logs),
                "completed_at": datetime.utcnow().isoformat()
            })

    except Exception as e:
        await r.hset(f"benchmark:{task_id}", mapping={
            "status": "error",
            "error": str(e),
            "log": "\n".join(logs) + f"\n\nError: {str(e)}"
        })
