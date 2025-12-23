# Fleet Agent for Windows GPU Nodes

This agent gives Fleet Commander full control over Windows Docker Desktop nodes with GPU support.

## Features

- GPU monitoring and metrics (nvidia-smi)
- Docker container management (run, stop, restart, remove)
- Docker image management (pull, list)
- Command execution
- Automatic registration and heartbeat
- Full Docker Desktop control

## Quick Install (One-Liner)

Open PowerShell as Administrator and run:

```powershell
irm http://192.168.1.214:8765/install/install-fleet-agent-windows.ps1 | iex
```

Or download and run manually:

```powershell
Invoke-WebRequest -Uri http://192.168.1.214:8765/install/install-fleet-agent-windows.ps1 -OutFile install.ps1
.\install.ps1
```

## Manual Install

1. Ensure Docker Desktop is running with GPU support
2. Pull and run the agent:

```powershell
docker pull 192.168.1.214:5000/fleet-agent-windows:latest
docker run -d --name fleet-agent --restart always -p 9100:9100 `
    -e FLEET_COMMANDER_URL=http://192.168.1.214:8765 `
    -e NODE_ID=$env:COMPUTERNAME `
    -e CLUSTER=windows `
    -v //var/run/docker.sock:/var/run/docker.sock `
    -v C:/ai-models:/models `
    -v C:/ai-outputs:/outputs `
    192.168.1.214:5000/fleet-agent-windows:latest
```

## Docker Desktop Setup

If pulling fails, add the registry to Docker Desktop:

1. Open Docker Desktop Settings
2. Go to Docker Engine
3. Add to the JSON:

```json
{
  "insecure-registries": ["192.168.1.214:5000"]
}
```

4. Click "Apply & Restart"

## API Endpoints

The agent exposes the following endpoints on port 9100:

### GET Endpoints
- `/health` - Health check
- `/metrics` - System and GPU metrics
- `/gpu` - GPU information
- `/containers` - List Docker containers
- `/docker/images` - List Docker images

### POST Endpoints
- `/exec` - Execute shell command
  ```json
  {"command": "dir", "timeout": 60}
  ```
- `/docker/run` - Run a container
  ```json
  {
    "name": "comfyui",
    "image": "ghcr.io/ai-dock/comfyui:latest",
    "gpu": true,
    "ports": ["8188:8188"],
    "volumes": ["C:/ai-models:/models"]
  }
  ```
- `/docker/stop` - Stop a container
  ```json
  {"container": "comfyui"}
  ```
- `/docker/rm` - Remove a container
  ```json
  {"container": "comfyui", "force": true}
  ```
- `/docker/pull` - Pull an image
  ```json
  {"image": "ghcr.io/ai-dock/comfyui:latest"}
  ```
- `/docker/logs` - Get container logs
  ```json
  {"container": "comfyui", "tail": 100}
  ```
- `/docker/restart` - Restart a container
  ```json
  {"container": "comfyui"}
  ```

## Deploying GPU Containers from Fleet Commander

Once the agent is running, Fleet Commander can deploy containers to this node:

```bash
# Deploy ComfyUI to a Windows node
curl -X POST http://192.168.1.100:9100/docker/run \
  -H "Content-Type: application/json" \
  -d '{
    "name": "comfyui",
    "image": "ghcr.io/ai-dock/comfyui:pytorch-2.4.0-py3.11-cuda-12.4.1-runtime-22.04",
    "gpu": true,
    "ports": ["8188:8188"],
    "volumes": ["C:/ai-models/checkpoints:/workspace/ComfyUI/models/checkpoints"]
  }'
```

## Uninstall

```powershell
docker stop fleet-agent
docker rm fleet-agent
docker rmi 192.168.1.214:5000/fleet-agent-windows:latest
```

## Troubleshooting

**Agent not appearing in Fleet Commander?**
- Check Docker is running: `docker ps`
- Check agent logs: `docker logs fleet-agent`
- Verify network connectivity to 192.168.1.214:8765

**GPU not detected?**
- Ensure NVIDIA drivers are installed
- Verify Docker GPU support: `docker run --gpus all nvidia/cuda:12.0-base nvidia-smi`

**Cannot pull from registry?**
- Add insecure registry to Docker Desktop settings
- Restart Docker Desktop after changes
