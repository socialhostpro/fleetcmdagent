# Bytebot - AI Desktop Agent

Self-hosted AI that has its own computer to complete tasks for you.

## Architecture
- **Virtual Desktop**: Ubuntu 22.04 with XFCE, Firefox, VS Code
- **AI Agent**: NestJS service coordinating decisions and actions
- **Web Interface**: Next.js for task management
- **APIs**: REST endpoints for programmatic control

## Ports
| Port | Service |
|------|---------|
| 9990 | Desktop control API |
| 9991 | Task creation API |
| 9992 | Web UI |

## Requirements
- **Platform**: x86-64 only (SPARK server, not Jetson AGX)
- **Memory**: 4-8GB RAM
- **AI Provider**: Anthropic Claude, OpenAI, or Ollama

## Quick Start

```bash
# Set your API key
export ANTHROPIC_API_KEY=sk-ant-...

# Start Bytebot
docker-compose up -d

# Open Web UI
open http://localhost:9992
```

## API Usage

```python
import httpx

# Create a task
resp = httpx.post("http://localhost:9991/api/tasks", json={
    "description": "Search Google for weather in NYC and take a screenshot"
})
task_id = resp.json()["id"]

# Check status
status = httpx.get(f"http://localhost:9991/api/tasks/{task_id}").json()
```

## Integration with Jessica AI

```python
# Jessica can delegate browser tasks to Bytebot
async def search_web(query: str):
    resp = await httpx.post("http://bytebot:9991/api/tasks", json={
        "description": f"Search the web for: {query}. Summarize the top 3 results."
    })
    return resp.json()
```

## Volume Mounts
- `/workspace` - Shared workspace for file operations
- `/outputs` - Generated files and screenshots
