import asyncio
from fastapi import APIRouter
from typing import List, Dict, Optional
import redis.asyncio as redis
import json
import re
from config import settings

router = APIRouter()
r = redis.from_url(settings.REDIS_URL, decode_responses=True)

# Known device patterns for identification
DEVICE_PATTERNS = {
    'spark': {
        'hostnames': ['spark', 'dgx', 'dgx-spark'],
        'mac_prefixes': [],  # Add NVIDIA DGX MAC prefixes if known
        'ports': [8765],  # Fleet Commander API
        'color': '#76b900',
        'icon': 'server',
    },
    'agx': {
        'hostnames': ['agx', 'xavier', 'jetson', 'orin'],
        'mac_prefixes': ['00:04:4b', '48:b0:2d', '70:66:55'],  # NVIDIA Jetson MAC prefixes
        'ports': [22],
        'color': '#3498db',
        'icon': 'cpu',
    },
    'windows': {
        'hostnames': ['win', 'desktop', 'pc', 'workstation', 'laptop'],
        'mac_prefixes': [],
        'ports': [135, 139, 445, 3389],  # Windows-specific ports
        'color': '#00a4ef',
        'icon': 'monitor',
    },
    'linux': {
        'hostnames': ['linux', 'ubuntu', 'debian', 'centos', 'fedora', 'server'],
        'mac_prefixes': [],
        'ports': [22],
        'color': '#f39c12',
        'icon': 'terminal',
    },
    'router': {
        'hostnames': ['router', 'gateway', 'firewall', 'openwrt', 'pfsense', 'unifi'],
        'mac_prefixes': [],
        'ports': [80, 443, 53],
        'color': '#9b59b6',
        'icon': 'router',
    },
}

def identify_device_type(hostname: str, ip: str, mac: str = "", open_ports: List[int] = None) -> Dict:
    """
    Identify the device type based on hostname, MAC address, and open ports.
    Returns device type info with label, color, and confidence.
    """
    hostname_lower = hostname.lower() if hostname else ""
    mac_lower = mac.lower() if mac else ""
    open_ports = open_ports or []

    # Check for known Fleet Commander nodes first (from Redis)
    # This would match nodes that have already registered

    # Check hostname patterns
    for device_type, patterns in DEVICE_PATTERNS.items():
        for pattern in patterns['hostnames']:
            if pattern in hostname_lower:
                return {
                    'type': device_type,
                    'label': device_type.upper(),
                    'color': patterns['color'],
                    'icon': patterns['icon'],
                    'confidence': 'high',
                    'match_reason': f'hostname contains "{pattern}"'
                }

    # Check MAC address prefixes (OUI)
    for device_type, patterns in DEVICE_PATTERNS.items():
        for mac_prefix in patterns['mac_prefixes']:
            if mac_lower.startswith(mac_prefix.lower()):
                return {
                    'type': device_type,
                    'label': device_type.upper(),
                    'color': patterns['color'],
                    'icon': patterns['icon'],
                    'confidence': 'high',
                    'match_reason': f'MAC prefix matches {device_type}'
                }

    # Check open ports for Windows
    windows_ports = set(DEVICE_PATTERNS['windows']['ports'])
    if open_ports and windows_ports.intersection(set(open_ports)):
        return {
            'type': 'windows',
            'label': 'WINDOWS',
            'color': DEVICE_PATTERNS['windows']['color'],
            'icon': DEVICE_PATTERNS['windows']['icon'],
            'confidence': 'medium',
            'match_reason': 'Windows ports detected'
        }

    # Check if IP ends in .1 (often router/gateway)
    if ip.endswith('.1'):
        return {
            'type': 'router',
            'label': 'GATEWAY',
            'color': DEVICE_PATTERNS['router']['color'],
            'icon': DEVICE_PATTERNS['router']['icon'],
            'confidence': 'low',
            'match_reason': 'IP ends in .1'
        }

    # Default to unknown
    return {
        'type': 'unknown',
        'label': 'UNKNOWN',
        'color': '#666666',
        'icon': 'help-circle',
        'confidence': 'none',
        'match_reason': None
    }

async def get_registered_nodes() -> Dict[str, Dict]:
    """Get nodes that are already registered with Fleet Commander."""
    nodes = {}
    node_ids = await r.smembers("nodes:active")
    for nid in node_ids:
        data = await r.get(f"node:{nid}:heartbeat")
        if data:
            node_data = json.loads(data)
            node_data['node_id'] = nid
            # Store by node_id AND by IP for lookup
            nodes[nid.lower()] = node_data
            if 'ip' in node_data:
                nodes[f"ip:{node_data['ip']}"] = node_data
    return nodes


def generate_node_alias(hostname: str, ip: str, index: int = 0) -> str:
    """Generate a unique node alias based on hostname or IP."""
    hostname_lower = hostname.lower() if hostname else ""

    # Try to extract a meaningful number from hostname
    # Pattern: gsagx0000-XXXX.lan -> use XXXX
    match = re.search(r'gsagx\d+-(\d+)', hostname_lower)
    if match:
        return f"agx-{match.group(1)}"

    # Pattern: agx0, agx1, agx2
    match = re.search(r'agx[-_]?(\d+)$', hostname_lower)
    if match:
        return f"agx-{match.group(1).zfill(2)}"

    # Fallback: use last octet of IP
    if ip:
        last_octet = ip.split('.')[-1]
        return f"agx-{last_octet}"

    # Last resort: use index
    return f"agx-{str(index).zfill(2)}"

@router.get("/scan")
async def scan_network(subnet: str = "192.168.1.0/24", refresh: bool = False):
    """
    Perform a comprehensive network scan with device identification.
    Uses nmap for discovery and port scanning.
    """
    cache_key = f"network:scan:{subnet}"

    if not refresh:
        cached = await r.get(cache_key)
        if cached:
            return json.loads(cached)

    try:
        # Get registered Fleet Commander nodes
        registered_nodes = await get_registered_nodes()

        # Run nmap with OS detection hints and common port scan
        # -sn: Ping scan (host discovery)
        # -PR: ARP ping (for local network)
        # --open: Only show open ports
        # -oX -: XML output to stdout
        process = await asyncio.create_subprocess_exec(
            "nmap", "-sn", "-PR", "-oG", "-", subnet,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        stdout, stderr = await process.communicate()

        if process.returncode != 0:
            return {"error": stderr.decode()}

        hosts = []
        for line in stdout.decode().splitlines():
            if "Status: Up" in line:
                # Example: Host: 192.168.1.100 (spark)	Status: Up
                parts = line.split()
                ip = parts[1]
                # Extract hostname from parentheses
                name_match = re.search(r'\(([^)]+)\)', line)
                name = name_match.group(1) if name_match else ""

                # Try to get MAC address if available in nmap output
                mac = ""
                mac_match = re.search(r'MAC Address: ([0-9A-Fa-f:]+)', line)
                if mac_match:
                    mac = mac_match.group(1)

                hosts.append({
                    "ip": ip,
                    "name": name,
                    "mac": mac,
                    "status": "online"
                })

        # Now do a quick port scan on discovered hosts for better identification
        if hosts:
            host_ips = [h['ip'] for h in hosts]
            port_scan = await scan_ports(host_ips)

            # Update hosts with port info and device identification
            agx_index = 0
            for host in hosts:
                ip = host['ip']
                host['open_ports'] = port_scan.get(ip, [])
                hostname_lower = host.get('name', '').lower()

                # Step 1: Check if this host is ACTUALLY registered with Fleet Commander
                # A node is only a "fleet node" if it has sent heartbeats to us
                is_fleet_node = False
                fleet_node_id = None
                registered_node_data = None

                # Check by IP (only reliable method - hostname matching is too unreliable)
                # A node is only a fleet node if we have a heartbeat from that exact IP
                if f"ip:{ip}" in registered_nodes:
                    is_fleet_node = True
                    registered_node_data = registered_nodes[f"ip:{ip}"]
                    fleet_node_id = registered_node_data.get('node_id')

                # Step 2: Identify device TYPE (AGX, Spark, Windows, etc.)
                # This is separate from whether it's a fleet node
                is_agx_device = any(x in hostname_lower for x in ['agx', 'gsagx', 'xavier', 'jetson', 'orin'])
                is_spark_device = any(x in hostname_lower for x in ['spark', 'dgx'])

                # Step 3: Determine device type and generate alias
                if is_spark_device:
                    host['device'] = {
                        'type': 'spark',
                        'label': 'DGX SPARK',
                        'color': '#76b900',
                        'icon': 'server',
                        'confidence': 'high',
                        'match_reason': 'Fleet Commander control plane'
                    }
                    fleet_node_id = fleet_node_id or 'spark'
                    # Spark is always considered "fleet node" if it's the control plane
                    if 8765 in host.get('open_ports', []):
                        is_fleet_node = True
                elif is_agx_device:
                    host['device'] = {
                        'type': 'agx',
                        'label': 'AGX XAVIER',
                        'color': '#3498db',
                        'icon': 'cpu',
                        'confidence': 'high',
                        'match_reason': 'Jetson AGX Xavier detected'
                    }
                    # Generate unique alias for this AGX
                    if not fleet_node_id:
                        fleet_node_id = generate_node_alias(host.get('name', ''), ip, agx_index)
                    agx_index += 1
                else:
                    # Identify device type by other means
                    host['device'] = identify_device_type(
                        host.get('name', ''),
                        host['ip'],
                        host.get('mac', ''),
                        host.get('open_ports', [])
                    )

                # Set fleet node status
                host['is_fleet_node'] = is_fleet_node
                host['fleet_node_id'] = fleet_node_id

                # Add registered node data if available
                if registered_node_data:
                    host['registered_data'] = {
                        'last_seen': registered_node_data.get('timestamp'),
                        'gpu': registered_node_data.get('gpu'),
                        'cpu_percent': registered_node_data.get('cpu_percent') or registered_node_data.get('cpu'),
                        'memory_percent': registered_node_data.get('memory', {}).get('percent'),
                        'power': registered_node_data.get('power'),
                        'activity': registered_node_data.get('activity'),
                    }

        # Sort hosts: Fleet nodes first, then by IP
        hosts.sort(key=lambda h: (
            0 if h.get('device', {}).get('type') == 'spark' else
            1 if h.get('device', {}).get('type') == 'agx' else
            2 if h.get('device', {}).get('type') == 'windows' else
            3,
            [int(x) for x in h['ip'].split('.')]
        ))

        # Count not_installed: installable devices (agx/linux) that are not fleet nodes
        not_installed = sum(
            1 for h in hosts
            if h.get('device', {}).get('type') in ('agx', 'linux')
            and not h.get('is_fleet_node')
        )

        result = {
            "hosts": hosts,
            "count": len(hosts),
            "fleet_nodes": sum(1 for h in hosts if h.get('is_fleet_node')),
            "not_installed": not_installed,
            "by_type": {}
        }

        # Count by type
        for host in hosts:
            dtype = host.get('device', {}).get('type', 'unknown')
            result["by_type"][dtype] = result["by_type"].get(dtype, 0) + 1

        # Cache for 5 minutes
        await r.set(cache_key, json.dumps(result), ex=300)
        return result

    except Exception as e:
        return {"error": str(e)}

async def scan_ports(ips: List[str], ports: str = "22,80,135,139,443,445,3389,8765") -> Dict[str, List[int]]:
    """
    Scan specific ports on a list of IPs.
    Returns dict mapping IP to list of open ports.
    """
    if not ips:
        return {}

    try:
        # Join IPs for batch scan
        ip_list = " ".join(ips)

        process = await asyncio.create_subprocess_exec(
            "nmap", "-Pn", "-p", ports, "--open", "-oG", "-", *ips,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        stdout, stderr = await process.communicate()

        result = {}
        for line in stdout.decode().splitlines():
            if "Ports:" in line:
                # Example: Host: 192.168.1.100 ()	Ports: 22/open/tcp//ssh///, 80/open/tcp//http///
                ip_match = re.search(r'Host: ([\d.]+)', line)
                ports_match = re.search(r'Ports: (.+?)(?:\t|$)', line)

                if ip_match and ports_match:
                    ip = ip_match.group(1)
                    ports_str = ports_match.group(1)
                    open_ports = []

                    for port_info in ports_str.split(", "):
                        port_num = port_info.split("/")[0]
                        if port_num.isdigit():
                            open_ports.append(int(port_num))

                    result[ip] = open_ports

        return result
    except Exception as e:
        print(f"Port scan error: {e}")
        return {}

@router.get("/refresh")
async def refresh_fleet_nodes():
    """
    Quick refresh of fleet nodes from Redis heartbeats.
    Returns only registered fleet nodes without doing a network scan.
    Use this after installing an agent to see it immediately.
    """
    # Get cluster labels and node IDs from Docker Swarm
    swarm_node_info = {}  # Maps IP/hostname to {cluster, node_id}
    try:
        import docker
        client = docker.from_env()
        for node in client.nodes.list():
            labels = node.attrs.get('Spec', {}).get('Labels', {})
            addr = node.attrs.get('Status', {}).get('Addr', '')
            hostname = node.attrs.get('Description', {}).get('Hostname', '')
            cluster = labels.get('cluster', '')
            node_id = node.id
            info = {'cluster': cluster, 'swarm_node_id': node_id}
            if addr:
                swarm_node_info[addr] = info
            if hostname:
                swarm_node_info[hostname] = info
    except Exception as e:
        print(f"Could not get swarm info: {e}")

    nodes = []
    node_ids = await r.smembers("nodes:active")

    for nid in node_ids:
        data = await r.get(f"node:{nid}:heartbeat")
        if data:
            node_data = json.loads(data)
            node_data['node_id'] = nid

            # Determine device type
            hostname_lower = nid.lower()
            is_agx = any(x in hostname_lower for x in ['agx', 'xavier', 'jetson', 'orin'])
            is_spark = any(x in hostname_lower for x in ['spark', 'dgx'])

            if is_spark:
                device = {
                    'type': 'spark',
                    'label': 'DGX SPARK',
                    'color': '#76b900',
                    'icon': 'server',
                }
            elif is_agx:
                device = {
                    'type': 'agx',
                    'label': 'AGX XAVIER',
                    'color': '#3498db',
                    'icon': 'cpu',
                }
            else:
                device = {
                    'type': 'linux',
                    'label': 'LINUX',
                    'color': '#f39c12',
                    'icon': 'terminal',
                }

            # Get cluster and swarm_node_id from swarm info (by IP or hostname)
            ip = node_data.get('ip', '')
            swarm_info = swarm_node_info.get(ip) or swarm_node_info.get(nid) or {}
            cluster = swarm_info.get('cluster', '')
            swarm_node_id = swarm_info.get('swarm_node_id', '')

            nodes.append({
                'ip': ip,
                'name': nid,
                'status': 'online',
                'is_fleet_node': True,
                'fleet_node_id': nid,
                'swarm_node_id': swarm_node_id,
                'device': device,
                'cluster': cluster,
                'registered_data': {
                    'last_seen': node_data.get('timestamp'),
                    'gpu': node_data.get('gpu'),
                    'cpu_percent': node_data.get('cpu_percent') or node_data.get('cpu'),
                    'memory_percent': node_data.get('memory', {}).get('percent'),
                    'power': node_data.get('power'),
                    'activity': node_data.get('activity'),
                    'docker': node_data.get('docker'),
                },
            })
        else:
            # Node heartbeat expired, remove from active set
            await r.srem("nodes:active", nid)

    # Sort by node ID
    nodes.sort(key=lambda h: h.get('fleet_node_id', ''))

    return {
        "hosts": nodes,
        "count": len(nodes),
        "fleet_nodes": len(nodes),
        "source": "redis_heartbeat",
        "by_type": {
            "agx": sum(1 for h in nodes if h.get('device', {}).get('type') == 'agx'),
            "spark": sum(1 for h in nodes if h.get('device', {}).get('type') == 'spark'),
            "linux": sum(1 for h in nodes if h.get('device', {}).get('type') == 'linux'),
        }
    }


@router.get("/identify/{ip}")
async def identify_host(ip: str):
    """
    Do a detailed identification scan on a single host.
    """
    try:
        # Run more detailed nmap scan
        process = await asyncio.create_subprocess_exec(
            "nmap", "-A", "-T4", "--top-ports", "100", ip,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        stdout, stderr = await process.communicate()

        output = stdout.decode()

        # Parse OS detection
        os_info = None
        os_match = re.search(r'OS details: (.+)', output)
        if os_match:
            os_info = os_match.group(1)

        # Parse MAC and vendor
        mac_info = None
        mac_match = re.search(r'MAC Address: ([0-9A-Fa-f:]+) \(([^)]+)\)', output)
        if mac_match:
            mac_info = {
                'address': mac_match.group(1),
                'vendor': mac_match.group(2)
            }

        # Parse open ports with services
        services = []
        for line in output.splitlines():
            port_match = re.match(r'(\d+)/tcp\s+open\s+(\S+)\s*(.*)', line)
            if port_match:
                services.append({
                    'port': int(port_match.group(1)),
                    'service': port_match.group(2),
                    'details': port_match.group(3).strip()
                })

        # Determine device type
        device_type = 'unknown'
        if os_info:
            os_lower = os_info.lower()
            if 'windows' in os_lower:
                device_type = 'windows'
            elif 'linux' in os_lower:
                if any(x in os_lower for x in ['jetson', 'tegra', 'nvidia']):
                    device_type = 'agx'
                else:
                    device_type = 'linux'

        if mac_info and 'nvidia' in mac_info.get('vendor', '').lower():
            device_type = 'agx'

        return {
            'ip': ip,
            'os': os_info,
            'mac': mac_info,
            'services': services,
            'device_type': device_type,
            'raw_output': output[:2000]  # Truncate for response size
        }

    except Exception as e:
        return {"error": str(e)}
