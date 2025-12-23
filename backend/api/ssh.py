import asyncio
import asyncssh
import redis.asyncio as redis
import json
import os
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional
from config import settings

router = APIRouter()

# Redis connection for looking up node IPs
r = redis.from_url(settings.REDIS_URL, decode_responses=True)

# Default credentials
DEFAULT_USERNAME = os.getenv("JETSON_DEFAULT_USER", "jetson")
DEFAULT_PASSWORD = os.getenv("JETSON_DEFAULT_PASS", "jetson")


class SSHRequest(BaseModel):
    host: str
    username: str
    password: str
    command: str
    port: int = 22


class SSHCredRequest(BaseModel):
    host: str
    credential_id: str
    command: str
    port: int = 22


@router.post("/exec")
async def execute_command(req: SSHRequest):
    """Execute SSH command with direct credentials."""
    try:
        async with asyncssh.connect(
            req.host,
            port=req.port,
            username=req.username,
            password=req.password,
            known_hosts=None
        ) as conn:
            result = await conn.run(req.command, timeout=60)
            return {
                "stdout": result.stdout,
                "stderr": result.stderr,
                "exit_status": result.exit_status
            }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/exec-cred")
async def execute_command_with_cred(req: SSHCredRequest):
    """Execute SSH command using credential from vault."""
    from api.vault import get_credential

    # Get credential
    cred = await get_credential(req.credential_id)
    if not cred:
        raise HTTPException(status_code=404, detail="Credential not found")

    try:
        async with asyncssh.connect(
            req.host,
            port=req.port,
            username=cred['username'],
            password=cred['password'],
            known_hosts=None
        ) as conn:
            result = await conn.run(req.command, timeout=60)
            return {
                "stdout": result.stdout,
                "stderr": result.stderr,
                "exit_status": result.exit_status
            }
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="Command timed out")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


class NodeExecRequest(BaseModel):
    node_id: str
    command: str


async def get_node_credentials(node_id: str):
    """Get credentials for a node from vault or defaults."""
    # Get node IP from heartbeat
    heartbeat = await r.get(f"node:{node_id}:heartbeat")
    if not heartbeat:
        return None, None

    node_data = json.loads(heartbeat)
    node_ip = node_data.get('ip')

    # Try to find credentials in vault
    creds = await r.hgetall("vault:credentials")
    for cred_json in creds.values():
        try:
            cred = json.loads(cred_json)
            if cred.get('host') == node_ip or cred.get('name', '').lower() == node_id.lower():
                return node_ip, cred
        except json.JSONDecodeError:
            continue

    # Return defaults
    return node_ip, {'username': DEFAULT_USERNAME, 'password': DEFAULT_PASSWORD}


@router.post("/exec-node")
async def execute_on_node(req: NodeExecRequest):
    """Execute SSH command on a node by node_id (looks up IP and credentials)."""
    node_ip, cred = await get_node_credentials(req.node_id)

    if not node_ip:
        raise HTTPException(status_code=404, detail=f"Node {req.node_id} not found")

    try:
        async with asyncssh.connect(
            node_ip,
            port=22,
            username=cred['username'],
            password=cred['password'],
            known_hosts=None,
            connect_timeout=10
        ) as conn:
            result = await conn.run(req.command, timeout=60)
            return {
                "node_id": req.node_id,
                "host": node_ip,
                "stdout": result.stdout,
                "stderr": result.stderr,
                "exit_status": result.exit_status
            }
    except asyncssh.PermissionDenied:
        raise HTTPException(status_code=401, detail="Permission denied - check credentials in vault")
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="Command timed out")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
