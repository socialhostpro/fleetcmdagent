import docker
from typing import List, Dict, Any, Optional

client = docker.from_env()

def get_swarm_status() -> Dict[str, Any]:
    """Get Docker Swarm status and info."""
    try:
        info = client.info()
        swarm_info = info.get("Swarm", {})

        # Get manager address from RemoteManagers
        manager_addr = ""
        remote_managers = swarm_info.get("RemoteManagers", [])
        if remote_managers:
            manager_addr = remote_managers[0].get("Addr", "")
        elif swarm_info.get("NodeAddr"):
            manager_addr = f"{swarm_info.get('NodeAddr')}:2377"

        return {
            "swarm": swarm_info,
            "containers": info.get("Containers", 0),
            "containers_running": info.get("ContainersRunning", 0),
            "images": info.get("Images", 0),
            "is_manager": swarm_info.get("ControlAvailable", False),
            "node_id": swarm_info.get("NodeID", ""),
            "cluster_id": swarm_info.get("Cluster", {}).get("ID", ""),
            "managers": swarm_info.get("Managers", 0),
            "nodes": swarm_info.get("Nodes", 0),
            "manager_addr": manager_addr,
            "state": swarm_info.get("LocalNodeState", "inactive"),
        }
    except Exception as e:
        return {"error": str(e)}

def get_services() -> List[Dict[str, Any]]:
    """Get all Docker Swarm services."""
    try:
        services = client.services.list()
        # Get all nodes for IP lookup
        nodes_map = {}
        try:
            for node in client.nodes.list():
                node_id = node.id
                node_name = node.attrs.get('Description', {}).get('Hostname', '')
                node_ip = node.attrs.get('Status', {}).get('Addr', '')
                nodes_map[node_id] = {'name': node_name, 'ip': node_ip}
        except Exception:
            pass

        result = []
        for s in services:
            spec = s.attrs.get('Spec', {})
            task_template = spec.get('TaskTemplate', {})
            container_spec = task_template.get('ContainerSpec', {})
            mode = spec.get('Mode', {})

            # Get replicas
            replicas = None
            if 'Replicated' in mode:
                replicas = mode['Replicated'].get('Replicas', 1)

            # Get task status and node info
            tasks = s.tasks()
            running_tasks = sum(1 for t in tasks if t.get('Status', {}).get('State') == 'running')

            # Find the node where a running task is placed
            node_name = None
            node_ip = None
            for t in tasks:
                if t.get('Status', {}).get('State') == 'running':
                    node_id = t.get('NodeID')
                    if node_id and node_id in nodes_map:
                        node_name = nodes_map[node_id]['name']
                        node_ip = nodes_map[node_id]['ip']
                    break

            result.append({
                "id": s.id,
                "name": s.name,
                "image": container_spec.get('Image', ''),
                "replicas": replicas,
                "running": running_tasks,
                "mode": "global" if 'Global' in mode else "replicated",
                "ports": spec.get('EndpointSpec', {}).get('Ports', []),
                "env": container_spec.get('Env', []),
                "node": node_name,
                "nodeIp": node_ip,
                "created_at": s.attrs.get('CreatedAt'),
                "updated_at": s.attrs.get('UpdatedAt'),
            })
        return result
    except Exception as e:
        return []

def get_service(service_id: str) -> Optional[Dict[str, Any]]:
    """Get a specific service by ID or name."""
    try:
        service = client.services.get(service_id)
        spec = service.attrs.get('Spec', {})
        task_template = spec.get('TaskTemplate', {})
        container_spec = task_template.get('ContainerSpec', {})
        mode = spec.get('Mode', {})

        tasks = service.tasks()
        running_tasks = sum(1 for t in tasks if t.get('Status', {}).get('State') == 'running')

        return {
            "id": service.id,
            "name": service.name,
            "image": container_spec.get('Image', ''),
            "replicas": mode.get('Replicated', {}).get('Replicas', 1) if 'Replicated' in mode else None,
            "running": running_tasks,
            "mode": "global" if 'Global' in mode else "replicated",
            "ports": spec.get('EndpointSpec', {}).get('Ports', []),
            "env": container_spec.get('Env', []),
            "mounts": container_spec.get('Mounts', []),
            "tasks": [{
                "id": t.get('ID'),
                "node_id": t.get('NodeID'),
                "state": t.get('Status', {}).get('State'),
                "message": t.get('Status', {}).get('Message'),
                "error": t.get('Status', {}).get('Err'),
            } for t in tasks],
            "created_at": service.attrs.get('CreatedAt'),
            "updated_at": service.attrs.get('UpdatedAt'),
        }
    except Exception as e:
        return None

def get_join_token(role: str = "worker") -> str:
    """Get the Swarm join token for workers or managers."""
    try:
        swarm = client.swarm
        return swarm.attrs.get("JoinTokens", {}).get(role.capitalize(), "")
    except Exception as e:
        return ""

def create_service(
    name: str,
    image: str,
    replicas: int = 1,
    mode: str = "replicated",
    ports: Optional[List[Dict]] = None,
    env: Optional[List[str]] = None,
    mounts: Optional[List[Dict]] = None,
    constraints: Optional[List[str]] = None,
    resources: Optional[Dict] = None,
    networks: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """Create a new Docker Swarm service."""
    try:
        # Build endpoint spec for ports
        endpoint_spec = None
        if ports:
            port_bindings = []
            for p in ports:
                port_bindings.append(docker.types.EndpointSpec(
                    ports={p.get('target_port'): p.get('published_port')}
                ))
            endpoint_spec = docker.types.EndpointSpec(
                ports={p.get('target_port'): p.get('published_port') for p in ports}
            )

        # Build resources spec for CPU/memory limits
        # Note: GPU scheduling requires NVIDIA runtime configured on Docker daemon
        resources_spec = None
        if resources:
            resources_spec = docker.types.Resources(
                cpu_limit=int(resources.get('cpu_limit')) if resources.get('cpu_limit') else None,
                mem_limit=int(resources.get('mem_limit')) if resources.get('mem_limit') else None,
            )

        # Build mode
        service_mode = docker.types.ServiceMode(
            mode='global' if mode == 'global' else 'replicated',
            replicas=replicas if mode != 'global' else None
        )

        # Build placement constraints
        placement = None
        if constraints:
            placement = docker.types.Placement(constraints=constraints)

        # Build mounts
        mount_specs = None
        if mounts:
            mount_specs = [
                docker.types.Mount(
                    target=m.get('target'),
                    source=m.get('source'),
                    type=m.get('type', 'bind'),
                    read_only=m.get('read_only', False)
                ) for m in mounts
            ]

        # Create the service
        service = client.services.create(
            image=image,
            name=name,
            mode=service_mode,
            endpoint_spec=endpoint_spec,
            env=env,
            mounts=mount_specs,
            constraints=constraints,
            resources=resources_spec,
            networks=networks,
        )

        return {
            "id": service.id,
            "name": name,
            "status": "created"
        }
    except Exception as e:
        return {"error": str(e)}

def update_service(
    service_id: str,
    image: Optional[str] = None,
    replicas: Optional[int] = None,
    env: Optional[List[str]] = None,
    force_update: bool = False
) -> Dict[str, Any]:
    """Update an existing Docker Swarm service."""
    try:
        service = client.services.get(service_id)

        kwargs = {}
        if image:
            kwargs['image'] = image
        if replicas is not None:
            kwargs['mode'] = docker.types.ServiceMode('replicated', replicas=replicas)
        if env:
            kwargs['env'] = env
        if force_update:
            kwargs['force_update'] = True

        service.update(**kwargs)
        return {"id": service.id, "status": "updated"}
    except Exception as e:
        return {"error": str(e)}

def scale_service(service_id: str, replicas: int) -> Dict[str, Any]:
    """Scale a service to a specific number of replicas."""
    try:
        service = client.services.get(service_id)
        service.scale(replicas)
        return {"id": service.id, "replicas": replicas, "status": "scaled"}
    except Exception as e:
        return {"error": str(e)}

def remove_service(service_id: str) -> Dict[str, Any]:
    """Remove a Docker Swarm service."""
    try:
        service = client.services.get(service_id)
        service.remove()
        return {"id": service_id, "status": "removed"}
    except Exception as e:
        return {"error": str(e)}

def get_service_logs(service_id: str, tail: int = 100) -> str:
    """Get logs from a service."""
    try:
        service = client.services.get(service_id)
        logs = service.logs(stdout=True, stderr=True, tail=tail)
        return logs.decode('utf-8') if isinstance(logs, bytes) else str(logs)
    except Exception as e:
        return f"Error: {str(e)}"

def get_nodes() -> List[Dict[str, Any]]:
    """Get all Docker Swarm nodes."""
    try:
        nodes = client.nodes.list()
        return [{
            "id": n.id,
            "hostname": n.attrs.get('Description', {}).get('Hostname', ''),
            "status": n.attrs.get('Status', {}).get('State', ''),
            "availability": n.attrs.get('Spec', {}).get('Availability', ''),
            "role": n.attrs.get('Spec', {}).get('Role', ''),
            "engine_version": n.attrs.get('Description', {}).get('Engine', {}).get('EngineVersion', ''),
            "ip": n.attrs.get('Status', {}).get('Addr', ''),
            "platform": {
                "os": n.attrs.get('Description', {}).get('Platform', {}).get('OS', ''),
                "arch": n.attrs.get('Description', {}).get('Platform', {}).get('Architecture', ''),
            },
            "resources": {
                "cpus": n.attrs.get('Description', {}).get('Resources', {}).get('NanoCPUs', 0) / 1e9,
                "memory": n.attrs.get('Description', {}).get('Resources', {}).get('MemoryBytes', 0),
            }
        } for n in nodes]
    except Exception as e:
        return []

def init_swarm(advertise_addr: Optional[str] = None) -> Dict[str, Any]:
    """Initialize a new Docker Swarm."""
    try:
        client.swarm.init(advertise_addr=advertise_addr)
        return {
            "status": "initialized",
            "worker_token": get_join_token("worker"),
            "manager_token": get_join_token("manager")
        }
    except Exception as e:
        return {"error": str(e)}

def leave_swarm(force: bool = False) -> Dict[str, Any]:
    """Leave the current Docker Swarm."""
    try:
        client.swarm.leave(force=force)
        return {"status": "left"}
    except Exception as e:
        return {"error": str(e)}


def get_local_containers() -> List[Dict[str, Any]]:
    """Get all local Docker containers (not Swarm services).

    This includes standalone containers running on SPARK that aren't managed by Swarm.
    """
    try:
        containers = client.containers.list(all=False)  # Only running containers
        result = []

        for c in containers:
            # Get port mappings
            ports = []
            port_data = c.attrs.get('NetworkSettings', {}).get('Ports', {})
            for container_port, bindings in port_data.items():
                if bindings:
                    for binding in bindings:
                        ports.append({
                            'container_port': container_port,
                            'host_ip': binding.get('HostIp', '0.0.0.0'),
                            'host_port': binding.get('HostPort', '')
                        })

            # Get health status
            health = c.attrs.get('State', {}).get('Health', {})
            health_status = health.get('Status', 'none') if health else 'none'

            result.append({
                "id": c.short_id,
                "name": c.name,
                "image": c.image.tags[0] if c.image.tags else c.attrs.get('Config', {}).get('Image', 'unknown'),
                "status": c.status,
                "health": health_status,
                "ports": ports,
                "created": c.attrs.get('Created', ''),
                "state": c.attrs.get('State', {}).get('Status', 'unknown'),
                "uptime": c.attrs.get('State', {}).get('StartedAt', ''),
            })

        return result
    except Exception as e:
        return []


def get_local_container(container_id: str) -> Optional[Dict[str, Any]]:
    """Get details for a specific local container."""
    try:
        c = client.containers.get(container_id)

        # Get port mappings
        ports = []
        port_data = c.attrs.get('NetworkSettings', {}).get('Ports', {})
        for container_port, bindings in port_data.items():
            if bindings:
                for binding in bindings:
                    ports.append({
                        'container_port': container_port,
                        'host_ip': binding.get('HostIp', '0.0.0.0'),
                        'host_port': binding.get('HostPort', '')
                    })

        # Get health status
        health = c.attrs.get('State', {}).get('Health', {})

        return {
            "id": c.short_id,
            "full_id": c.id,
            "name": c.name,
            "image": c.image.tags[0] if c.image.tags else c.attrs.get('Config', {}).get('Image', 'unknown'),
            "status": c.status,
            "health": health.get('Status', 'none') if health else 'none',
            "ports": ports,
            "created": c.attrs.get('Created', ''),
            "state": c.attrs.get('State', {}),
            "config": {
                "env": c.attrs.get('Config', {}).get('Env', []),
                "cmd": c.attrs.get('Config', {}).get('Cmd', []),
            },
            "mounts": [
                {"source": m.get('Source'), "destination": m.get('Destination'), "mode": m.get('Mode')}
                for m in c.attrs.get('Mounts', [])
            ],
            "networks": list(c.attrs.get('NetworkSettings', {}).get('Networks', {}).keys()),
        }
    except Exception as e:
        return None


def get_container_logs(container_id: str, tail: int = 100) -> str:
    """Get logs from a specific container."""
    try:
        c = client.containers.get(container_id)
        logs = c.logs(tail=tail, timestamps=True)
        return logs.decode('utf-8') if isinstance(logs, bytes) else str(logs)
    except Exception as e:
        return f"Error: {str(e)}"
