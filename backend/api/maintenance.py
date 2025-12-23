import asyncio
import asyncssh
from fastapi import APIRouter, HTTPException, BackgroundTasks
from pydantic import BaseModel
from typing import List, Optional, Dict, Any
import redis.asyncio as redis
import json
import uuid
import os
from config import settings
from minio import Minio
from minio.error import S3Error

router = APIRouter()
r = redis.from_url(settings.REDIS_URL, decode_responses=True)

# MinIO configuration
MINIO_URL = os.getenv("MINIO_URL", "http://comfyui-minio:9000").replace("http://", "").replace("https://", "")
MINIO_ACCESS_KEY = os.getenv("MINIO_ACCESS_KEY", "minioadmin")
MINIO_SECRET_KEY = os.getenv("MINIO_SECRET_KEY", "minioadmin123")

def get_minio_client():
    """Get MinIO client instance."""
    return Minio(
        MINIO_URL,
        access_key=MINIO_ACCESS_KEY,
        secret_key=MINIO_SECRET_KEY,
        secure=False
    )

# Default credentials for Jetson nodes (can be overridden via env vars)
DEFAULT_USERNAME = os.getenv("JETSON_DEFAULT_USER", "jetson")
DEFAULT_PASSWORD = os.getenv("JETSON_DEFAULT_PASS", "jetson")

class CleanupRequest(BaseModel):
    node_ip: str
    actions: List[str]  # ['docker', 'apt', 'logs', 'tmp', 'journal', 'pip']
    username: Optional[str] = None
    password: Optional[str] = None

class DiskAnalysisRequest(BaseModel):
    node_ip: str
    username: Optional[str] = None
    password: Optional[str] = None

async def get_credential_for_node(node_ip: str, username: str = None, password: str = None) -> Dict:
    """Get credential for a node - uses default if not specified."""
    # First check if there's a stored credential for this IP
    creds = await r.hgetall("vault:credentials")
    for cred_json in creds.values():
        cred = json.loads(cred_json)
        if cred.get('host') == node_ip or cred.get('name', '').lower() == node_ip.lower():
            return cred

    # Use provided or default credentials
    return {
        'username': username or DEFAULT_USERNAME,
        'password': password or DEFAULT_PASSWORD
    }

def parse_size(size_str):
    """Extract size from du output like '1.2G\t/path' or '512M'."""
    if not size_str or size_str == 'N/A':
        return 'N/A'
    # Handle du output format: "1.2G\t/path/to/dir"
    parts = size_str.split()
    if parts:
        return parts[0]
    return size_str

def parse_docker_df(output):
    """Parse docker system df output into structured data."""
    result = {
        'images_count': 0,
        'containers_count': 0,
        'volumes_count': 0,
        'build_cache': 'N/A',
        'total_size': 'N/A',
        'reclaimable': 'N/A'
    }
    if not output or 'not available' in output.lower():
        return result

    lines = output.strip().split('\n')
    total_size = 0
    for line in lines:
        if line.startswith('Images'):
            parts = line.split()
            if len(parts) >= 4:
                result['images_count'] = int(parts[1]) if parts[1].isdigit() else 0
        elif line.startswith('Containers'):
            parts = line.split()
            if len(parts) >= 4:
                result['containers_count'] = int(parts[1]) if parts[1].isdigit() else 0
        elif line.startswith('Local Volumes'):
            parts = line.split()
            if len(parts) >= 4:
                result['volumes_count'] = int(parts[2]) if parts[2].isdigit() else 0
        elif line.startswith('Build cache'):
            parts = line.split()
            if len(parts) >= 4:
                result['build_cache'] = parts[2] if len(parts) > 2 else 'N/A'

    return result

@router.post("/disk/audit")
async def audit_disk(req: DiskAnalysisRequest):
    """Full disk audit - categorize all space usage."""
    cred = await get_credential_for_node(req.node_ip, req.username, req.password)

    try:
        async with asyncssh.connect(
            req.node_ip,
            username=cred['username'],
            password=cred['password'],
            known_hosts=None,
            connect_timeout=60
        ) as conn:
            sudo_prefix = f"echo '{cred['password']}' | sudo -S " if cred['username'] != 'root' else ""
            audit = {'essential': [], 'cleanable': [], 'unknown': []}

            # Get total disk info
            df_result = await conn.run("df -h / | tail -1")
            audit['disk_info'] = df_result.stdout.strip()

            # Essential NVIDIA/JetPack directories (DO NOT DELETE)
            essential_paths = [
                ('/usr/local/cuda', 'CUDA Toolkit'),
                ('/usr/lib/aarch64-linux-gnu', 'System Libraries (CUDA, TensorRT, cuDNN)'),
                ('/usr/share', 'System Data/Docs'),
                ('/usr/bin', 'System Binaries'),
                ('/usr/src', 'Kernel Sources'),
                ('/lib/firmware', 'Firmware'),
                ('/lib/modules', 'Kernel Modules'),
                ('/opt/nvidia', 'NVIDIA Tools'),
                ('/boot', 'Boot Files'),
            ]

            for path, desc in essential_paths:
                result = await conn.run(f"{sudo_prefix}du -sh {path} 2>/dev/null | cut -f1")
                size = result.stdout.strip() if result.exit_status == 0 and result.stdout.strip() else 'N/A'
                if size != 'N/A':
                    audit['essential'].append({'path': path, 'size': size, 'desc': desc, 'deletable': False})

            # Potentially cleanable paths
            cleanable_paths = [
                ('/var/lib/docker', 'Docker Data', True),
                ('/var/log', 'System Logs', True),
                ('/var/cache', 'System Cache', True),
                ('/tmp', 'Temp Files', True),
                ('/opt/ota_package', 'OTA Updates (can delete after update)', True),
                ('/home', 'User Home Directories', 'partial'),
                ('/root', 'Root Home', 'partial'),
                ('/var/lib/apt', 'APT Package Lists', True),
                ('/var/lib/snapd', 'Snap Data', True),
                ('/snap', 'Snap Packages', True),
            ]

            for path, desc, deletable in cleanable_paths:
                result = await conn.run(f"{sudo_prefix}du -sh {path} 2>/dev/null | cut -f1")
                size = result.stdout.strip() if result.exit_status == 0 and result.stdout.strip() else 'N/A'
                if size != 'N/A':
                    audit['cleanable'].append({'path': path, 'size': size, 'desc': desc, 'deletable': deletable})

            # Check for large files anywhere
            large_files_result = await conn.run(f"{sudo_prefix}find / -xdev -type f -size +100M -exec ls -lh {{}} \\; 2>/dev/null | head -20")
            audit['large_files'] = large_files_result.stdout.strip().split('\n') if large_files_result.exit_status == 0 else []

            # Summarize
            audit['summary'] = {
                'message': 'JetPack with CUDA typically uses 15-18GB. This is NORMAL.',
                'essential_note': 'NVIDIA/CUDA directories cannot be deleted without breaking GPU compute.',
                'recommendation': 'Focus on Docker, logs, cache, and ensure AI outputs go to S3.'
            }

            return audit

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/disk/analyze")
async def analyze_disk(req: DiskAnalysisRequest):
    """Analyze disk usage on a remote node - FAST version."""
    cred = await get_credential_for_node(req.node_ip, req.username, req.password)

    try:
        async with asyncssh.connect(
            req.node_ip,
            username=cred['username'],
            password=cred['password'],
            known_hosts=None,
            connect_timeout=15
        ) as conn:
            results = {}
            sudo_prefix = f"echo '{cred['password']}' | sudo -S " if cred['username'] != 'root' else ""

            # FAST: Single combined command instead of many sequential ones
            fast_cmd = f"""{sudo_prefix}bash -c '
df -h / | tail -1 | awk "{{print \\"DF:\\"\$2,\$3,\$4,\$5}}"
echo "DOCKER:$(docker system df --format "{{{{.Type}}}}:{{{{.TotalCount}}}}:{{{{.Size}}}}" 2>/dev/null | tr "\\n" "|" || echo "N/A")"
echo "JOURNAL:$(journalctl --disk-usage 2>/dev/null | grep -oE "[0-9.]+[KMGT]?B?" | head -1 || echo "N/A")"
echo "APT:$(du -sh /var/cache/apt/archives 2>/dev/null | cut -f1 || echo "N/A")"
echo "TMP:$(du -sh /tmp 2>/dev/null | cut -f1 || echo "N/A")"
echo "LOGS:$(du -sh /var/log 2>/dev/null | cut -f1 || echo "N/A")"
echo "PIP:$(du -sh ~/.cache/pip 2>/dev/null | cut -f1 || echo "N/A")"
echo "OLLAMA:$(du -sh /usr/share/ollama 2>/dev/null | cut -f1 || echo "N/A")"
echo "BROWSERS:$(dpkg-query -W -f "\${{Installed-Size}} " chromium-browser thunderbird firefox 2>/dev/null || echo "0")"
du -sh /* 2>/dev/null | sort -hr | head -8 | sed "s/^/DIR:/"
'"""
            result = await conn.run(fast_cmd, check=False)
            output = result.stdout.strip() if result.stdout else ""

            # Parse the fast output
            large_dirs = []
            for line in output.split('\n'):
                if line.startswith('DF:'):
                    parts = line[3:].split()
                    if len(parts) >= 4:
                        results['disk'] = {
                            'total': parts[0], 'used': parts[1],
                            'free': parts[2], 'percent': parts[3].replace('%', '')
                        }
                elif line.startswith('DOCKER:'):
                    results['docker'] = parse_docker_df(line[7:])
                elif line.startswith('JOURNAL:'):
                    results['journal'] = {'size': line[8:] or 'N/A'}
                elif line.startswith('APT:'):
                    results['apt_cache'] = {'size': line[4:] or 'N/A'}
                elif line.startswith('TMP:'):
                    results['tmp'] = {'size': line[4:] or 'N/A'}
                elif line.startswith('LOGS:'):
                    results['logs'] = {'size': line[5:] or 'N/A'}
                elif line.startswith('PIP:'):
                    results['pip_cache'] = {'size': line[4:] or 'N/A'}
                elif line.startswith('OLLAMA:'):
                    size = line[7:] or 'N/A'
                    results['ollama'] = {'size': size, 'installed': size != 'N/A' and size != '0'}
                elif line.startswith('BROWSERS:'):
                    try:
                        sizes = [int(s) for s in line[9:].split() if s.isdigit()]
                        total_kb = sum(sizes)
                        results['browsers'] = {
                            'size': f"{total_kb // 1024}M" if total_kb > 0 else 'N/A',
                            'details': [],
                            'installed': total_kb > 0
                        }
                    except:
                        results['browsers'] = {'size': 'N/A', 'details': [], 'installed': False}
                elif line.startswith('DIR:'):
                    parts = line[4:].split('\t')
                    if len(parts) >= 2:
                        path = parts[1].strip()
                        if path and not any(x in path for x in ['/proc', '/sys', '/dev', '/run']):
                            large_dirs.append({'size': parts[0], 'path': path})

            results['large_dirs'] = large_dirs
            return results

    except asyncssh.PermissionDenied:
        raise HTTPException(status_code=401, detail="Permission denied - check credentials")
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="Connection timeout")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/disk/cleanup")
async def cleanup_disk(req: CleanupRequest, background_tasks: BackgroundTasks):
    """Start disk cleanup on a remote node."""
    cred = await get_credential_for_node(req.node_ip, req.username, req.password)

    task_id = str(uuid.uuid4())
    await r.hset(f"cleanup:{task_id}", mapping={
        "status": "running",
        "host": req.node_ip,
        "actions": json.dumps(req.actions)
    })

    background_tasks.add_task(run_cleanup, task_id, req.node_ip, cred, req.actions)
    return {"task_id": task_id, "status": "started"}

async def run_cleanup(task_id: str, host: str, cred: dict, actions: List[str]):
    """Run cleanup commands on a node."""
    logs = []

    try:
        async with asyncssh.connect(
            host,
            username=cred['username'],
            password=cred['password'],
            known_hosts=None,
            connect_timeout=30
        ) as conn:
            sudo_prefix = f"echo '{cred['password']}' | sudo -S " if cred['username'] != 'root' else ""

            if 'docker' in actions:
                logs.append("=== AGGRESSIVE Docker Cleanup ===")
                logs.append("(Docker is usually 50%+ of disk usage)")

                # Stop non-essential containers first
                result = await conn.run(f"{sudo_prefix}docker ps -q --filter 'name=fleet' | xargs -r docker stop 2>&1 || true")

                # Remove ALL stopped containers
                result = await conn.run(f"{sudo_prefix}docker container prune -f 2>&1")
                logs.append(f"Containers: {result.stdout.strip()}")

                # Remove ALL unused images (not just dangling) - this is the big one!
                result = await conn.run(f"{sudo_prefix}docker image prune -a -f 2>&1")
                logs.append(f"Images: {result.stdout.strip()}")

                # Remove ALL unused volumes
                result = await conn.run(f"{sudo_prefix}docker volume prune -f 2>&1")
                logs.append(f"Volumes: {result.stdout.strip()}")

                # Remove ALL networks
                result = await conn.run(f"{sudo_prefix}docker network prune -f 2>&1")
                logs.append(f"Networks: {result.stdout.strip()}")

                # Remove ALL build cache
                result = await conn.run(f"{sudo_prefix}docker builder prune -a -f 2>&1")
                logs.append(f"Build cache: {result.stdout.strip()}")

                # Show remaining docker usage
                result = await conn.run(f"{sudo_prefix}docker system df 2>&1")
                logs.append(f"Docker usage after: {result.stdout.strip()}")

            if 'apt' in actions:
                logs.append("\n=== APT Cleanup ===")
                result = await conn.run(f"{sudo_prefix}apt-get clean 2>&1")
                logs.append(f"apt-get clean: Done")

                result = await conn.run(f"{sudo_prefix}apt-get autoremove -y 2>&1")
                logs.append(f"apt-get autoremove: {result.stdout}")

            if 'logs' in actions:
                logs.append("\n=== Log Cleanup ===")
                # Truncate large log files
                result = await conn.run(f"{sudo_prefix}find /var/log -type f -name '*.log' -size +50M -exec truncate -s 0 {{}} \\; 2>&1")
                logs.append("Truncated large log files (>50MB)")

                # Remove old rotated logs
                result = await conn.run(f"{sudo_prefix}find /var/log -type f -name '*.gz' -delete 2>&1")
                logs.append("Removed rotated .gz logs")

                result = await conn.run(f"{sudo_prefix}find /var/log -type f -name '*.old' -delete 2>&1")
                logs.append("Removed .old logs")

            if 'journal' in actions:
                logs.append("\n=== Journal Cleanup ===")
                result = await conn.run(f"{sudo_prefix}journalctl --vacuum-size=100M 2>&1")
                logs.append(f"Journal: {result.stdout}")

            if 'tmp' in actions:
                logs.append("\n=== Temp Cleanup ===")
                result = await conn.run(f"{sudo_prefix}find /tmp -type f -atime +7 -delete 2>&1")
                logs.append("Removed temp files older than 7 days")

                result = await conn.run(f"{sudo_prefix}rm -rf /tmp/* 2>&1 || true")
                logs.append("Cleaned /tmp")

            if 'pip' in actions:
                logs.append("\n=== Pip/ML Cache Cleanup ===")
                # Pip cache
                result = await conn.run(f"{sudo_prefix}rm -rf /home/*/.cache/pip/* ~/.cache/pip/* /root/.cache/pip/* 2>&1 || true")
                logs.append("Cleaned pip cache")

                # Huggingface cache (models)
                result = await conn.run(f"{sudo_prefix}rm -rf /home/*/.cache/huggingface/* ~/.cache/huggingface/* /root/.cache/huggingface/* 2>&1 || true")
                logs.append("Cleaned Huggingface cache")

                # Torch cache
                result = await conn.run(f"{sudo_prefix}rm -rf /home/*/.cache/torch/* ~/.cache/torch/* /root/.cache/torch/* 2>&1 || true")
                logs.append("Cleaned Torch cache")

                # Triton cache
                result = await conn.run(f"{sudo_prefix}rm -rf /home/*/.triton/* 2>&1 || true")
                logs.append("Cleaned Triton cache")

            if 'outputs' in actions:
                logs.append("\n=== AI Output Cleanup ===")
                # ComfyUI outputs
                result = await conn.run(f"{sudo_prefix}rm -rf /home/*/ComfyUI/output/* /opt/ComfyUI/output/* 2>&1 || true")
                logs.append("Cleaned ComfyUI outputs")

                # Other common output directories
                result = await conn.run(f"{sudo_prefix}rm -rf /home/*/output/* ~/output/* 2>&1 || true")
                logs.append("Cleaned output directories")
                logs.append("NOTE: Outputs should go to S3 at /mnt/s3-outputs!")

            if 'ollama' in actions:
                logs.append("\n=== Ollama Cleanup ===")
                # Stop Ollama service first
                result = await conn.run(f"{sudo_prefix}systemctl stop ollama 2>&1 || true")
                logs.append("Stopped Ollama service")

                # Remove Ollama models (the big space consumers - 1-8GB each!)
                result = await conn.run(f"{sudo_prefix}rm -rf /usr/share/ollama/.ollama/models/* 2>&1 || true")
                logs.append("Removed Ollama models from /usr/share/ollama")

                result = await conn.run(f"{sudo_prefix}rm -rf /home/*/.ollama/models/* ~/.ollama/models/* /root/.ollama/models/* 2>&1 || true")
                logs.append("Removed Ollama models from home directories")

                # Remove Ollama blobs (cached model data)
                result = await conn.run(f"{sudo_prefix}rm -rf /usr/share/ollama/.ollama/blobs/* 2>&1 || true")
                result = await conn.run(f"{sudo_prefix}rm -rf /home/*/.ollama/blobs/* ~/.ollama/blobs/* /root/.ollama/blobs/* 2>&1 || true")
                logs.append("Removed Ollama blobs/cache")

                logs.append("NOTE: Re-download models with 'ollama pull <model>' when needed")

            if 'browsers' in actions:
                logs.append("\n=== Browser Cleanup ===")
                # Remove Chromium and its data (can be reinstalled if needed)
                result = await conn.run(f"{sudo_prefix}apt-get remove --purge -y chromium-browser chromium-browser-l10n chromium-codecs-ffmpeg 2>&1 || true")
                logs.append("Removed Chromium browser")

                # Remove Chromium cache and profile data
                result = await conn.run(f"{sudo_prefix}rm -rf /home/*/.config/chromium /home/*/.cache/chromium 2>&1 || true")
                result = await conn.run(f"{sudo_prefix}rm -rf ~/.config/chromium ~/.cache/chromium 2>&1 || true")
                logs.append("Removed Chromium user data")

                # Remove Firefox if present
                result = await conn.run(f"{sudo_prefix}apt-get remove --purge -y firefox 2>&1 || true")
                result = await conn.run(f"{sudo_prefix}rm -rf /home/*/.mozilla /home/*/.cache/mozilla 2>&1 || true")
                logs.append("Removed Firefox (if present)")

                # Remove Thunderbird email client
                result = await conn.run(f"{sudo_prefix}apt-get remove --purge -y thunderbird 2>&1 || true")
                result = await conn.run(f"{sudo_prefix}rm -rf /home/*/.thunderbird 2>&1 || true")
                logs.append("Removed Thunderbird email client")

                # Clean up removed packages
                result = await conn.run(f"{sudo_prefix}apt-get autoremove -y 2>&1 || true")
                logs.append("Cleaned up orphaned dependencies")

                logs.append("NOTE: Browsers can be reinstalled with 'apt install chromium-browser'")

            # Get new disk usage
            df_result = await conn.run("df -h / | tail -1 | awk '{print $5}'")
            new_usage = df_result.stdout.strip() if df_result.exit_status == 0 else "unknown"
            logs.append(f"\n=== Disk usage after cleanup: {new_usage} ===")

            await r.hset(f"cleanup:{task_id}", mapping={
                "status": "completed",
                "log": "\n".join(logs),
                "new_usage": new_usage
            })

    except Exception as e:
        await r.hset(f"cleanup:{task_id}", mapping={
            "status": "error",
            "error": str(e),
            "log": "\n".join(logs) + f"\n\nError: {str(e)}"
        })

@router.get("/disk/cleanup/{task_id}")
async def get_cleanup_status(task_id: str):
    """Get cleanup task status."""
    task = await r.hgetall(f"cleanup:{task_id}")
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    return task

@router.delete("/disk/cleanup/{task_id}")
async def delete_cleanup_task(task_id: str):
    """Delete cleanup task data."""
    await r.delete(f"cleanup:{task_id}")
    return {"status": "deleted"}

class RestartAgentRequest(BaseModel):
    node_ip: str
    username: Optional[str] = None
    password: Optional[str] = None

@router.post("/restart-agent")
async def restart_agent(req: RestartAgentRequest):
    """Restart the fleet-agent service on a remote node."""
    cred = await get_credential_for_node(req.node_ip, req.username, req.password)

    try:
        async with asyncssh.connect(
            req.node_ip,
            username=cred['username'],
            password=cred['password'],
            known_hosts=None,
            connect_timeout=15
        ) as conn:
            sudo_prefix = f"echo '{cred['password']}' | sudo -S " if cred['username'] != 'root' else ""

            # Restart the fleet-agent service
            result = await conn.run(f"{sudo_prefix}systemctl restart fleet-agent 2>&1", check=False)
            output = result.stdout.strip() if result.stdout else ""

            if result.exit_status != 0:
                return {
                    "status": "warning",
                    "message": f"Restart command returned exit code {result.exit_status}",
                    "output": output
                }

            return {
                "status": "success",
                "message": f"fleet-agent restarted on {req.node_ip}",
                "output": output
            }

    except asyncssh.PermissionDenied:
        raise HTTPException(status_code=401, detail="Permission denied - check credentials")
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="Connection timeout")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

class HealthCheckRequest(BaseModel):
    node_ip: str
    username: Optional[str] = None
    password: Optional[str] = None

class S3MountRequest(BaseModel):
    node_ip: str
    spark_ip: Optional[str] = None
    username: Optional[str] = None
    password: Optional[str] = None
    minio_access_key: Optional[str] = "minioadmin"
    minio_secret_key: Optional[str] = "minioadmin123"

@router.post("/fix-s3-mounts")
async def fix_s3_mounts(req: S3MountRequest):
    """Fix or setup S3 mounts on a remote node."""
    cred = await get_credential_for_node(req.node_ip, req.username, req.password)
    spark_ip = req.spark_ip or os.getenv("SPARK_IP", "192.168.1.100")

    try:
        async with asyncssh.connect(
            req.node_ip,
            username=cred['username'],
            password=cred['password'],
            known_hosts=None,
            connect_timeout=30
        ) as conn:
            sudo_prefix = f"echo '{cred['password']}' | sudo -S " if cred['username'] != 'root' else ""
            logs = []

            # Install s3fs if not present
            s3fs_check = await conn.run("which s3fs", check=False)
            if s3fs_check.exit_status != 0:
                logs.append("Installing s3fs...")
                await conn.run(f"{sudo_prefix}apt-get update && {sudo_prefix}apt-get install -y s3fs", check=False)
                logs.append("s3fs installed")

            # Create credentials file
            logs.append("Configuring S3 credentials...")
            await conn.run(f"{sudo_prefix}bash -c 'echo \"{req.minio_access_key}:{req.minio_secret_key}\" > /etc/passwd-s3fs'", check=False)
            await conn.run(f"{sudo_prefix}chmod 600 /etc/passwd-s3fs", check=False)

            # Create mount points
            await conn.run(f"{sudo_prefix}mkdir -p /mnt/s3-models /mnt/s3-outputs", check=False)
            logs.append("Mount points created")

            # Unmount existing if any
            await conn.run(f"{sudo_prefix}umount -f /mnt/s3-models 2>/dev/null || true", check=False)
            await conn.run(f"{sudo_prefix}umount -f /mnt/s3-outputs 2>/dev/null || true", check=False)

            # Update fstab
            await conn.run(f"{sudo_prefix}sed -i '/s3-models/d' /etc/fstab", check=False)
            await conn.run(f"{sudo_prefix}sed -i '/s3-outputs/d' /etc/fstab", check=False)

            # MinIO is exposed on port 9010 (mapped from container's 9000)
            minio_url = f"http://{spark_ip}:9010"
            fstab_models = f"fleet-models /mnt/s3-models fuse.s3fs _netdev,allow_other,use_path_request_style,url={minio_url},passwd_file=/etc/passwd-s3fs,ro 0 0"
            fstab_outputs = f"fleet-outputs /mnt/s3-outputs fuse.s3fs _netdev,allow_other,use_path_request_style,url={minio_url},passwd_file=/etc/passwd-s3fs 0 0"

            await conn.run(f"{sudo_prefix}bash -c 'echo \"{fstab_models}\" >> /etc/fstab'", check=False)
            await conn.run(f"{sudo_prefix}bash -c 'echo \"{fstab_outputs}\" >> /etc/fstab'", check=False)
            logs.append("fstab updated")

            # Try to mount
            mount_result = await conn.run(f"{sudo_prefix}mount -a 2>&1", check=False)
            if mount_result.exit_status == 0:
                logs.append("Mounts successful!")
            else:
                logs.append(f"Mount warning: {mount_result.stdout or mount_result.stderr}")
                logs.append("Ensure MinIO buckets 'fleet-models' and 'fleet-outputs' exist on Spark")

            # Verify mounts
            verify = await conn.run("mount | grep s3fs", check=False)
            if verify.stdout:
                logs.append(f"Active mounts: {verify.stdout.strip()}")
            else:
                logs.append("No s3fs mounts active yet")

            return {
                "status": "completed",
                "logs": logs,
                "spark_ip": spark_ip,
                "minio_url": minio_url
            }

    except asyncssh.PermissionDenied:
        raise HTTPException(status_code=401, detail="Permission denied - check credentials")
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="Connection timeout")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/health-check")
async def health_check(req: HealthCheckRequest):
    """Run health checks on a remote node - SSH, agent, docker, S3 mounts."""
    cred = await get_credential_for_node(req.node_ip, req.username, req.password)

    results = {
        "ssh": False,
        "agent": False,
        "docker": False,
        "s3_mounts": False,
        "details": {}
    }

    try:
        async with asyncssh.connect(
            req.node_ip,
            username=cred['username'],
            password=cred['password'],
            known_hosts=None,
            connect_timeout=10
        ) as conn:
            # SSH is working if we got here
            results["ssh"] = True

            # Check fleet-agent service
            agent_result = await conn.run("systemctl is-active fleet-agent 2>/dev/null || echo 'inactive'", check=False)
            agent_status = agent_result.stdout.strip() if agent_result.stdout else "unknown"
            results["agent"] = agent_status == "active"
            results["details"]["agent_status"] = agent_status

            # Check Docker
            docker_result = await conn.run("docker info --format '{{.ServerVersion}}' 2>/dev/null || echo 'not running'", check=False)
            docker_version = docker_result.stdout.strip() if docker_result.stdout else "not running"
            results["docker"] = docker_version != "not running" and docker_version != ""
            results["details"]["docker_version"] = docker_version

            # Check S3 mounts - look for s3fs mounts or the mount points
            mount_result = await conn.run("mount | grep -E 's3fs|s3-models|s3-outputs|fleet-models|fleet-outputs' 2>/dev/null || echo ''", check=False)
            mount_output = mount_result.stdout.strip() if mount_result.stdout else ""
            mount_lines = [l for l in mount_output.split('\n') if l.strip()]
            mount_count = len(mount_lines)

            # Also check if mount points exist and are accessible
            mount_check = await conn.run("ls /mnt/s3-models /mnt/s3-outputs 2>/dev/null && echo 'accessible' || echo 'not_accessible'", check=False)
            mounts_accessible = "accessible" in mount_check.stdout if mount_check.stdout else False

            results["s3_mounts"] = mount_count >= 2 or mounts_accessible
            results["details"]["s3_mount_count"] = mount_count
            results["details"]["s3_mounts_info"] = mount_lines[:2] if mount_lines else ["No S3 mounts detected"]
            results["details"]["s3_paths_accessible"] = mounts_accessible

            # Extra: Check disk space
            df_result = await conn.run("df -h / | tail -1 | awk '{print $5}'", check=False)
            disk_usage = df_result.stdout.strip() if df_result.stdout else "unknown"
            results["details"]["disk_usage"] = disk_usage

            return results

    except asyncssh.PermissionDenied:
        results["error"] = "Permission denied - check credentials"
        return results
    except asyncio.TimeoutError:
        results["error"] = "Connection timeout - node unreachable"
        return results
    except Exception as e:
        results["error"] = str(e)
        return results

# === MinIO Bucket Management ===

REQUIRED_BUCKETS = ["fleet-models", "fleet-outputs"]

@router.get("/minio/status")
async def minio_status():
    """Check MinIO connection and bucket status."""
    try:
        client = get_minio_client()
        buckets = list(client.list_buckets())
        bucket_names = [b.name for b in buckets]

        result = {
            "connected": True,
            "endpoint": MINIO_URL,
            "buckets": bucket_names,
            "required_buckets": {}
        }

        for bucket_name in REQUIRED_BUCKETS:
            exists = bucket_name in bucket_names
            result["required_buckets"][bucket_name] = {
                "exists": exists,
                "status": "ok" if exists else "missing"
            }

        result["all_required_exist"] = all(
            b in bucket_names for b in REQUIRED_BUCKETS
        )

        return result

    except S3Error as e:
        return {
            "connected": False,
            "error": f"S3 Error: {str(e)}",
            "endpoint": MINIO_URL
        }
    except Exception as e:
        return {
            "connected": False,
            "error": str(e),
            "endpoint": MINIO_URL
        }

@router.post("/minio/create-buckets")
async def create_minio_buckets():
    """Create required MinIO buckets if they don't exist."""
    try:
        client = get_minio_client()
        results = {}

        for bucket_name in REQUIRED_BUCKETS:
            try:
                if not client.bucket_exists(bucket_name):
                    client.make_bucket(bucket_name)
                    results[bucket_name] = "created"
                else:
                    results[bucket_name] = "already_exists"
            except S3Error as e:
                results[bucket_name] = f"error: {str(e)}"

        return {
            "status": "completed",
            "buckets": results,
            "endpoint": MINIO_URL
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
