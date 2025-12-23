"""AI Assistant API for Fleet Management using Ollama."""
import os
import json
import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional, List, Dict, Any
import redis.asyncio as redis
from config import settings
import docker

router = APIRouter()
r = redis.from_url(settings.REDIS_URL, decode_responses=True)

OLLAMA_URL = os.getenv("OLLAMA_URL", "http://jessica-ollama-gb10:11434")
DEFAULT_MODEL = "llama3.1:8b"

class ChatMessage(BaseModel):
    role: str  # 'user', 'assistant', 'system'
    content: str

class ChatRequest(BaseModel):
    message: str
    context: Optional[str] = None  # 'fleet', 'troubleshoot', 'general'
    include_fleet_status: bool = True
    model: Optional[str] = None

class ChatResponse(BaseModel):
    response: str
    fleet_context: Optional[Dict[str, Any]] = None

async def get_fleet_context() -> Dict[str, Any]:
    """Gather comprehensive fleet status for AI context."""
    context = {
        "nodes": [],
        "clusters": {},
        "swarm_status": {},
        "issues": []
    }

    try:
        # Get node statuses from Redis
        node_ids = await r.smembers("nodes:active")
        total_power = 0
        offline_nodes = []

        for nid in node_ids:
            data = await r.get(f"node:{nid}:heartbeat")
            if data:
                node = json.loads(data)
                node_summary = {
                    "id": node.get("node_id"),
                    "ip": node.get("ip"),
                    "cpu": node.get("cpu_percent", node.get("cpu", 0)),
                    "memory_percent": node.get("memory", {}).get("percent", 0),
                    "disk_percent": node.get("disk", {}).get("percent", 0),
                    "power_w": node.get("power", {}).get("total_w", 0),
                    "activity": node.get("activity", {}).get("status", "unknown")
                }
                context["nodes"].append(node_summary)
                total_power += node_summary["power_w"]

                # Detect issues
                if node_summary["disk_percent"] > 85:
                    context["issues"].append(f"Node {nid} has high disk usage ({node_summary['disk_percent']}%)")
                if node_summary["memory_percent"] > 90:
                    context["issues"].append(f"Node {nid} has high memory usage ({node_summary['memory_percent']}%)")
            else:
                offline_nodes.append(nid)

        if offline_nodes:
            context["issues"].append(f"Offline nodes: {', '.join(offline_nodes)}")

        context["total_power_w"] = round(total_power, 1)
        context["active_nodes"] = len(context["nodes"])

        # Get Docker Swarm status
        try:
            client = docker.from_env()
            swarm_info = client.info().get("Swarm", {})
            context["swarm_status"] = {
                "state": swarm_info.get("LocalNodeState", "unknown"),
                "managers": swarm_info.get("Managers", 0),
                "nodes": swarm_info.get("Nodes", 0)
            }

            # Get cluster assignments from swarm labels
            for node in client.nodes.list():
                labels = node.attrs.get("Spec", {}).get("Labels", {})
                cluster = labels.get("cluster", "unassigned")
                if cluster not in context["clusters"]:
                    context["clusters"][cluster] = []
                ip = node.attrs.get("Status", {}).get("Addr", "")
                context["clusters"][cluster].append({
                    "hostname": node.attrs.get("Description", {}).get("Hostname"),
                    "ip": ip,
                    "status": node.attrs.get("Status", {}).get("State")
                })

            # Get running services
            services = client.services.list()
            context["services"] = [{"name": s.name, "replicas": s.attrs.get("Spec", {}).get("Mode", {}).get("Replicated", {}).get("Replicas", 0)} for s in services]
        except Exception as e:
            context["swarm_error"] = str(e)

    except Exception as e:
        context["error"] = str(e)

    return context

def build_system_prompt(context: str = "fleet") -> str:
    """Build system prompt based on context."""
    base_prompt = """You are Fleet Commander AI, an intelligent assistant for managing a GPU compute cluster.
The fleet consists of NVIDIA Jetson AGX Xavier nodes used for AI/ML workloads like image generation with ComfyUI.

Your capabilities:
- Analyze fleet health and performance metrics
- Troubleshoot issues with nodes, Docker, and Swarm
- Suggest optimizations for power, performance, and resource usage
- Help manage cluster assignments and service deployments
- Explain technical concepts related to GPU computing and Docker

When analyzing issues:
1. Look at CPU, memory, disk, and power metrics
2. Consider cluster assignments and node availability
3. Check for Docker/Swarm connectivity issues
4. Suggest specific actionable steps

Keep responses concise and technical. Use markdown for formatting when helpful."""

    if context == "troubleshoot":
        return base_prompt + "\n\nFocus on identifying problems and providing step-by-step solutions."
    elif context == "optimize":
        return base_prompt + "\n\nFocus on performance optimization and resource efficiency."
    else:
        return base_prompt

@router.post("/chat", response_model=ChatResponse)
async def chat(request: ChatRequest):
    """Chat with Fleet Commander AI."""
    model = request.model or DEFAULT_MODEL

    # Build context
    fleet_context = None
    context_text = ""

    if request.include_fleet_status:
        fleet_context = await get_fleet_context()
        context_text = f"\n\nCurrent Fleet Status:\n```json\n{json.dumps(fleet_context, indent=2)}\n```\n"

    system_prompt = build_system_prompt(request.context)

    # Build messages for Ollama
    messages = [
        {"role": "system", "content": system_prompt + context_text},
        {"role": "user", "content": request.message}
    ]

    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            response = await client.post(
                f"{OLLAMA_URL}/api/chat",
                json={
                    "model": model,
                    "messages": messages,
                    "stream": False
                }
            )

            if response.status_code != 200:
                raise HTTPException(status_code=response.status_code, detail=f"Ollama error: {response.text}")

            result = response.json()
            ai_response = result.get("message", {}).get("content", "No response generated")

            return ChatResponse(
                response=ai_response,
                fleet_context=fleet_context if request.include_fleet_status else None
            )
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="AI request timed out")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"AI error: {str(e)}")

@router.get("/models")
async def list_models():
    """List available Ollama models."""
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(f"{OLLAMA_URL}/api/tags")
            if response.status_code == 200:
                data = response.json()
                return {
                    "models": [{"name": m["name"], "size": m.get("size", 0)} for m in data.get("models", [])],
                    "default": DEFAULT_MODEL
                }
            else:
                raise HTTPException(status_code=response.status_code, detail="Failed to get models")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/analyze")
async def analyze_fleet():
    """Get AI analysis of current fleet status."""
    fleet_context = await get_fleet_context()

    # Generate automatic analysis
    prompt = """Analyze this fleet status and provide a brief summary including:
1. Overall health assessment
2. Any issues or warnings
3. Performance observations
4. Recommended actions (if any)

Be concise but thorough."""

    request = ChatRequest(
        message=prompt,
        context="fleet",
        include_fleet_status=True
    )

    try:
        result = await chat(request)
        return {
            "analysis": result.response,
            "fleet_status": fleet_context
        }
    except Exception as e:
        return {
            "analysis": f"Unable to generate analysis: {str(e)}",
            "fleet_status": fleet_context
        }

@router.post("/troubleshoot")
async def troubleshoot(issue: str):
    """Get AI help troubleshooting a specific issue."""
    request = ChatRequest(
        message=f"Help me troubleshoot this issue: {issue}",
        context="troubleshoot",
        include_fleet_status=True
    )
    return await chat(request)
