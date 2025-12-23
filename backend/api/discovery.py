"""
Network Discovery API for auto-discovering and adding AGX/Linux nodes
"""
from fastapi import APIRouter, HTTPException, BackgroundTasks
from pydantic import BaseModel
from typing import List, Optional, Dict, Any
import asyncio
import asyncssh
import json
import redis.asyncio as redis
from config import settings
from services import docker_service

router = APIRouter()
r = redis.from_url(settings.REDIS_URL, decode_responses=True)

# Settings keys
SETTINGS_KEY = "discovery:settings"
DISCOVERED_KEY = "discovery:nodes"
SCAN_STATUS_KEY = "discovery:scan_status"

class DiscoverySettings(BaseModel):
    enabled: bool = False
    auto_join: bool = False  # Automatically join discovered nodes to swarm
    default_credential_id: Optional[str] = None  # Vault credential to use
    scan_subnets: List[str] = ["192.168.1.0/24"]  # Subnets to scan
    scan_interval_minutes: int = 60  # How often to scan
    exclude_ips: List[str] = []  # IPs to exclude from scanning

class DiscoveredNode(BaseModel):
    ip: str
    hostname: Optional[str] = None
    os_type: Optional[str] = None  # 'jetson', 'linux', 'unknown'
    jetson_model: Optional[str] = None  # 'xavier', 'orin', etc.
    docker_installed: bool = False
    swarm_status: Optional[str] = None  # 'not_joined', 'worker', 'manager'
    ssh_accessible: bool = False
    last_seen: Optional[str] = None
    auto_join_status: Optional[str] = None  # 'pending', 'success', 'failed', 'skipped'

class ScanRequest(BaseModel):
    subnet: Optional[str] = None  # Override default subnet
    force: bool = False  # Ignore cached results

class JoinNodeRequest(BaseModel):
    ip: str
    credential_id: Optional[str] = None  # Use specific credential, or default
    cluster_label: Optional[str] = None  # Cluster to assign (vision, media-gen, etc.)

@router.get("/settings")
async def get_settings():
    """Get discovery settings."""
    settings_data = await r.get(SETTINGS_KEY)
    if settings_data:
        return json.loads(settings_data)
    return DiscoverySettings().model_dump()

@router.post("/settings")
async def save_settings(settings: DiscoverySettings):
    """Save discovery settings."""
    await r.set(SETTINGS_KEY, settings.model_dump_json())
    return {"status": "saved", "settings": settings.model_dump()}

@router.get("/nodes")
async def get_discovered_nodes():
    """Get list of discovered nodes."""
    nodes = await r.hgetall(DISCOVERED_KEY)
    return [json.loads(v) for v in nodes.values()]

@router.get("/scan-status")
async def get_scan_status():
    """Get current scan status."""
    status = await r.get(SCAN_STATUS_KEY)
    if status:
        return json.loads(status)
    return {"status": "idle", "progress": 0, "found": 0}

@router.post("/scan")
async def start_scan(req: ScanRequest, background_tasks: BackgroundTasks):
    """Start a network scan for nodes."""
    # Check if scan is already running
    status = await r.get(SCAN_STATUS_KEY)
    if status:
        current = json.loads(status)
        if current.get("status") == "running":
            raise HTTPException(status_code=409, detail="Scan already in progress")

    # Get settings
    settings_data = await r.get(SETTINGS_KEY)
    disc_settings = DiscoverySettings(**json.loads(settings_data)) if settings_data else DiscoverySettings()

    subnet = req.subnet or (disc_settings.scan_subnets[0] if disc_settings.scan_subnets else "192.168.1.0/24")

    # Start scan in background
    background_tasks.add_task(run_network_scan, subnet, disc_settings.exclude_ips)

    return {"status": "started", "subnet": subnet}

async def run_network_scan(subnet: str, exclude_ips: List[str]):
    """Background task to scan network."""
    try:
        await r.set(SCAN_STATUS_KEY, json.dumps({
            "status": "running",
            "progress": 0,
            "found": 0,
            "subnet": subnet
        }))

        # Parse subnet for IP range
        base_ip = subnet.rsplit('.', 1)[0]
        discovered = []

        # Scan IPs 1-254
        for i in range(1, 255):
            ip = f"{base_ip}.{i}"

            if ip in exclude_ips:
                continue

            # Update progress
            await r.set(SCAN_STATUS_KEY, json.dumps({
                "status": "running",
                "progress": int((i / 254) * 100),
                "found": len(discovered),
                "current_ip": ip
            }))

            # Quick ping check
            try:
                proc = await asyncio.create_subprocess_exec(
                    'ping', '-c', '1', '-W', '1', ip,
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.DEVNULL
                )
                await asyncio.wait_for(proc.wait(), timeout=2)

                if proc.returncode == 0:
                    # Host is up, probe it
                    node_info = await probe_node(ip)
                    if node_info:
                        discovered.append(node_info)
                        # Save to Redis
                        await r.hset(DISCOVERED_KEY, ip, json.dumps(node_info))

            except asyncio.TimeoutError:
                pass
            except Exception:
                pass

        # Scan complete
        await r.set(SCAN_STATUS_KEY, json.dumps({
            "status": "completed",
            "progress": 100,
            "found": len(discovered),
            "subnet": subnet
        }))

    except Exception as e:
        await r.set(SCAN_STATUS_KEY, json.dumps({
            "status": "error",
            "error": str(e)
        }))

async def probe_node(ip: str) -> Optional[Dict[str, Any]]:
    """Probe a node to determine its type and capabilities."""
    from datetime import datetime

    node = {
        "ip": ip,
        "hostname": None,
        "os_type": "unknown",
        "jetson_model": None,
        "docker_installed": False,
        "swarm_status": "not_joined",
        "ssh_accessible": False,
        "last_seen": datetime.now().isoformat(),
        "auto_join_status": None
    }

    # Check if it's an existing swarm node
    try:
        nodes = docker_service.get_nodes()
        for swarm_node in nodes:
            if swarm_node.get("status", {}).get("addr") == ip:
                node["swarm_status"] = swarm_node.get("spec", {}).get("role", "worker")
                node["hostname"] = swarm_node.get("description", {}).get("hostname")
                break
    except Exception:
        pass

    # Check SSH port (22)
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(ip, 22),
            timeout=2
        )
        node["ssh_accessible"] = True
        writer.close()
        await writer.wait_closed()
    except Exception:
        pass

    # Check Docker port (2375/2376)
    for port in [2375, 2376]:
        try:
            reader, writer = await asyncio.wait_for(
                asyncio.open_connection(ip, port),
                timeout=1
            )
            node["docker_installed"] = True
            writer.close()
            await writer.wait_closed()
            break
        except Exception:
            pass

    return node

@router.post("/join")
async def join_node(req: JoinNodeRequest):
    """Join a discovered node to the swarm."""
    # Get vault credentials
    cred = None

    if req.credential_id:
        cred_data = await r.hget("vault:credentials", req.credential_id)
        if cred_data:
            cred = json.loads(cred_data)
    else:
        # Try to get default from settings
        settings_data = await r.get(SETTINGS_KEY)
        if settings_data:
            disc_settings = json.loads(settings_data)
            default_cred_id = disc_settings.get("default_credential_id")
            if default_cred_id:
                cred_data = await r.hget("vault:credentials", default_cred_id)
                if cred_data:
                    cred = json.loads(cred_data)

    if not cred:
        raise HTTPException(status_code=400, detail="No credentials available. Add credentials to vault first.")

    # Get swarm join token and manager address
    token = docker_service.get_join_token("worker")
    if not token:
        raise HTTPException(status_code=400, detail="Swarm not initialized")

    swarm_status = docker_service.get_swarm_status()
    manager_addr = swarm_status.get("manager_addr", "192.168.1.214:2377")

    try:
        async with asyncssh.connect(
            req.ip,
            username=cred["username"],
            password=cred["password"],
            known_hosts=None,
            connect_timeout=30
        ) as conn:
            sudo_prefix = f"echo '{cred['password']}' | sudo -S " if cred["username"] != 'root' else ""

            # Get hostname
            hostname_result = await conn.run("hostname", check=False)
            hostname = hostname_result.stdout.strip() if hostname_result.stdout else req.ip

            # Check if already in swarm
            check_result = await conn.run(f"{sudo_prefix}docker info --format '{{{{.Swarm.LocalNodeState}}}}'", check=False)
            current_state = check_result.stdout.strip() if check_result.stdout else ""

            if current_state == "active":
                # Leave existing swarm first
                await conn.run(f"{sudo_prefix}docker swarm leave --force", check=False)
                await asyncio.sleep(2)

            # Check if Jetson
            jetson_result = await conn.run("cat /etc/nv_tegra_release 2>/dev/null || echo ''", check=False)
            jetson_model = None
            os_type = "linux"

            if jetson_result.stdout and "NVIDIA" in jetson_result.stdout:
                os_type = "jetson"
                if "Xavier" in jetson_result.stdout or "t194" in jetson_result.stdout:
                    jetson_model = "xavier"
                elif "Orin" in jetson_result.stdout or "t234" in jetson_result.stdout:
                    jetson_model = "orin"
                else:
                    jetson_model = "unknown"

            # Join the swarm
            join_cmd = f"{sudo_prefix}docker swarm join --token {token} {manager_addr}"
            result = await conn.run(join_cmd, check=False)

            if result.exit_status != 0:
                # Update node status
                await r.hset(DISCOVERED_KEY, req.ip, json.dumps({
                    "ip": req.ip,
                    "hostname": hostname,
                    "os_type": os_type,
                    "jetson_model": jetson_model,
                    "docker_installed": True,
                    "swarm_status": "not_joined",
                    "ssh_accessible": True,
                    "auto_join_status": "failed"
                }))
                return {
                    "status": "error",
                    "message": result.stderr or result.stdout or "Failed to join swarm",
                    "ip": req.ip
                }

            # Get the node ID
            node_id_result = await conn.run(f"{sudo_prefix}docker info --format '{{{{.Swarm.NodeID}}}}'", check=False)
            node_id = node_id_result.stdout.strip() if node_id_result.stdout else None

            # Apply labels (cluster, nvidia, gpu)
            if node_id:
                import docker
                client = docker.from_env()
                try:
                    node = client.nodes.get(node_id)
                    spec = node.attrs['Spec']
                    spec['Labels'] = spec.get('Labels', {})

                    if req.cluster_label:
                        spec['Labels']['cluster'] = req.cluster_label

                    if os_type == "jetson":
                        spec['Labels']['nvidia'] = 'true'
                        spec['Labels']['gpu'] = 'jetson'
                        if jetson_model:
                            spec['Labels']['gpu_type'] = jetson_model

                    node.update(spec)
                except Exception:
                    pass

            # Update discovered node status
            await r.hset(DISCOVERED_KEY, req.ip, json.dumps({
                "ip": req.ip,
                "hostname": hostname,
                "os_type": os_type,
                "jetson_model": jetson_model,
                "docker_installed": True,
                "swarm_status": "worker",
                "ssh_accessible": True,
                "auto_join_status": "success"
            }))

            return {
                "status": "success",
                "message": f"Node {hostname} ({req.ip}) joined swarm successfully",
                "node_id": node_id,
                "hostname": hostname,
                "os_type": os_type,
                "jetson_model": jetson_model,
                "cluster": req.cluster_label
            }

    except asyncssh.PermissionDenied:
        await r.hset(DISCOVERED_KEY, req.ip, json.dumps({
            "ip": req.ip,
            "ssh_accessible": True,
            "auto_join_status": "failed"
        }))
        raise HTTPException(status_code=401, detail="Permission denied - check credentials")
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="Connection timeout")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/auto-join-all")
async def auto_join_all(background_tasks: BackgroundTasks, cluster_label: Optional[str] = None):
    """Auto-join all discovered nodes that are not yet in the swarm."""
    nodes_data = await r.hgetall(DISCOVERED_KEY)
    nodes = [json.loads(v) for v in nodes_data.values()]

    pending_nodes = [
        n for n in nodes
        if n.get("ssh_accessible") and n.get("swarm_status") == "not_joined"
    ]

    if not pending_nodes:
        return {"status": "no_pending_nodes", "message": "No discoverable nodes to join"}

    # Queue joins in background
    background_tasks.add_task(run_auto_join, pending_nodes, cluster_label)

    return {
        "status": "started",
        "pending_count": len(pending_nodes),
        "nodes": [n["ip"] for n in pending_nodes]
    }

async def run_auto_join(nodes: List[Dict], cluster_label: Optional[str]):
    """Background task to auto-join multiple nodes."""
    for node in nodes:
        try:
            # Update status to pending
            node["auto_join_status"] = "pending"
            await r.hset(DISCOVERED_KEY, node["ip"], json.dumps(node))

            # Join the node
            req = JoinNodeRequest(ip=node["ip"], cluster_label=cluster_label)
            # This is a background task, so we call the join logic directly
            # rather than the endpoint
            settings_data = await r.get(SETTINGS_KEY)
            disc_settings = json.loads(settings_data) if settings_data else {}
            cred_id = disc_settings.get("default_credential_id")

            if cred_id:
                req.credential_id = cred_id
                # Direct call - we're in background task
                try:
                    cred_data = await r.hget("vault:credentials", cred_id)
                    if cred_data:
                        cred = json.loads(cred_data)
                        token = docker_service.get_join_token("worker")
                        swarm_status = docker_service.get_swarm_status()
                        manager_addr = swarm_status.get("manager_addr", "192.168.1.214:2377")

                        async with asyncssh.connect(
                            node["ip"],
                            username=cred["username"],
                            password=cred["password"],
                            known_hosts=None,
                            connect_timeout=30
                        ) as conn:
                            sudo_prefix = f"echo '{cred['password']}' | sudo -S " if cred["username"] != 'root' else ""

                            # Leave if in swarm
                            check_result = await conn.run(f"{sudo_prefix}docker info --format '{{{{.Swarm.LocalNodeState}}}}'", check=False)
                            if check_result.stdout and check_result.stdout.strip() == "active":
                                await conn.run(f"{sudo_prefix}docker swarm leave --force", check=False)
                                await asyncio.sleep(2)

                            # Join
                            join_cmd = f"{sudo_prefix}docker swarm join --token {token} {manager_addr}"
                            result = await conn.run(join_cmd, check=False)

                            if result.exit_status == 0:
                                node["swarm_status"] = "worker"
                                node["auto_join_status"] = "success"
                            else:
                                node["auto_join_status"] = "failed"

                            await r.hset(DISCOVERED_KEY, node["ip"], json.dumps(node))

                except Exception as e:
                    node["auto_join_status"] = "failed"
                    await r.hset(DISCOVERED_KEY, node["ip"], json.dumps(node))

        except Exception as e:
            node["auto_join_status"] = "failed"
            await r.hset(DISCOVERED_KEY, node["ip"], json.dumps(node))

@router.delete("/nodes/{ip}")
async def remove_discovered_node(ip: str):
    """Remove a node from discovered list."""
    await r.hdel(DISCOVERED_KEY, ip)
    return {"status": "removed", "ip": ip}

@router.post("/clear")
async def clear_discovered():
    """Clear all discovered nodes."""
    await r.delete(DISCOVERED_KEY)
    return {"status": "cleared"}
