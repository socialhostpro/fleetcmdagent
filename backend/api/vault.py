from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import List, Optional
import json
import redis.asyncio as redis
from config import settings
import uuid

router = APIRouter()
r = redis.from_url(settings.REDIS_URL, decode_responses=True)

class Credential(BaseModel):
    id: Optional[str] = None
    name: str
    username: str
    password: str  # In a real app, encrypt this!

@router.post("/")
async def save_credential(cred: Credential):
    if not cred.id:
        cred.id = str(uuid.uuid4())
    await r.hset("vault:credentials", cred.id, cred.model_dump_json())
    return {"status": "saved", "id": cred.id}

@router.get("/", response_model=List[Credential])
async def list_credentials():
    creds = await r.hgetall("vault:credentials")
    return [json.loads(v) for v in creds.values()]

@router.delete("/{cred_id}")
async def delete_credential(cred_id: str):
    await r.hdel("vault:credentials", cred_id)
    return {"status": "deleted"}


@router.get("/{cred_id}")
async def get_credential_by_id(cred_id: str):
    """Get a specific credential by ID."""
    cred_json = await r.hget("vault:credentials", cred_id)
    if not cred_json:
        raise HTTPException(status_code=404, detail="Credential not found")
    return json.loads(cred_json)


async def get_credential(cred_id: str):
    """Helper function to get credential for internal use."""
    cred_json = await r.hget("vault:credentials", cred_id)
    if not cred_json:
        return None
    return json.loads(cred_json)
