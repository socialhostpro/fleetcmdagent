# Fleet Commander API Documentation

Complete API reference for integrating with Fleet Commander (AGX Cloud Commander).

## Base URL

```
http://192.168.1.214:8765/api
```

## Authentication

Currently no authentication required for local network access. All endpoints are open.

---

## Table of Contents

1. [Nodes API](#nodes-api)
2. [Swarm API](#swarm-api)
3. [Clusters API](#clusters-api)
4. [Vision/Image Generation API](#vision-api)
5. [SSH Execution API](#ssh-api)
6. [Network Discovery API](#network-api)
7. [Build & Deploy API](#build-api)
8. [Install Queue API](#install-queue-api)
9. [Maintenance API](#maintenance-api)
10. [Vault (Credentials) API](#vault-api)
11. [AI Assistant API](#ai-api)
12. [WebSocket Endpoints](#websocket-api)

---

## Nodes API

Base: `/api/nodes`

### List All Nodes

```http
GET /api/nodes/
```

**Response:**
```json
{
  "nodes": [
    {
      "id": "agx0",
      "hostname": "agx0",
      "ip": "192.168.1.182",
      "status": "online",
      "cluster": "vision",
      "cpu": 15.2,
      "memory": 45.8,
      "gpu": 0,
      "gpu_memory": 12.5,
      "temperature": 45,
      "disk": 65.2,
      "last_seen": "2024-12-21T17:30:00Z"
    }
  ]
}
```

### Get Node JetPack Info

```http
GET /api/nodes/jetpack
GET /api/nodes/{node_id}/jetpack
```

**Response:**
```json
{
  "jetpack_version": "5.1.2",
  "l4t_version": "35.4.1",
  "cuda_version": "11.4",
  "cudnn_version": "8.6.0"
}
```

---

## Swarm API

Base: `/api/swarm`

### Get Swarm Status

```http
GET /api/swarm/status
```

**Response:**
```json
{
  "is_manager": true,
  "swarm_id": "abc123...",
  "manager_addr": "192.168.1.214:2377",
  "nodes_count": 10,
  "managers_count": 1,
  "workers_count": 9
}
```

### List Swarm Nodes

```http
GET /api/swarm/nodes
```

**Response:**
```json
[
  {
    "id": "node123...",
    "hostname": "agx0",
    "status": "ready",
    "availability": "active",
    "role": "worker",
    "labels": {
      "cluster": "vision",
      "nvidia": "true"
    }
  }
]
```

### Get Join Token

```http
GET /api/swarm/join-token?role=worker
```

**Parameters:**
- `role`: `worker` or `manager`

**Response:**
```json
{
  "token": "SWMTKN-1-xxx...",
  "role": "worker"
}
```

### Join Remote Node to Swarm

```http
POST /api/swarm/join-remote
```

**Request:**
```json
{
  "node_ip": "192.168.1.182",
  "username": "nvidia",
  "password": "nvidia",
  "cluster": "vision"
}
```

**Response:**
```json
{
  "status": "success",
  "message": "Node 192.168.1.182 joined swarm successfully",
  "node_id": "xyz123...",
  "cluster": "vision"
}
```

### Update Node Labels

```http
POST /api/swarm/nodes/{node_id}/labels
```

**Request:**
```json
{
  "labels": {
    "cluster": "vision",
    "nvidia": "true"
  }
}
```

### List Services

```http
GET /api/swarm/services
```

**Response:**
```json
[
  {
    "id": "svc123...",
    "name": "vision-sdxl",
    "image": "192.168.1.214:5000/sdxl-trt:r35.3.1",
    "replicas": 1,
    "running": 1,
    "mode": "replicated"
  }
]
```

### Create Service

```http
POST /api/swarm/services
```

**Request:**
```json
{
  "name": "vision-sdxl",
  "image": "192.168.1.214:5000/sdxl-trt:r35.3.1",
  "replicas": 1,
  "mode": "replicated",
  "ports": [
    {"target_port": 8080, "published_port": 8080}
  ],
  "env": ["CUDA_VISIBLE_DEVICES=0"],
  "mounts": [
    {"source": "/mnt/s3-models", "target": "/models"}
  ],
  "constraints": [
    "node.labels.cluster==vision",
    "node.labels.nvidia==true"
  ],
  "resources": {
    "gpu": 1
  }
}
```

### Scale Service

```http
POST /api/swarm/services/{service_id}/scale
```

**Request:**
```json
{
  "replicas": 3
}
```

### Get Service Logs

```http
GET /api/swarm/services/{service_id}/logs?tail=100
```

### Delete Service

```http
DELETE /api/swarm/services/{service_id}
```

### List Local Containers (SPARK)

```http
GET /api/swarm/containers
```

**Response:**
```json
{
  "containers": [
    {
      "id": "abc123...",
      "name": "comfyui",
      "image": "comfyui:latest",
      "status": "running",
      "ports": {"8188/tcp": 8188}
    }
  ],
  "total": 5,
  "server": "SPARK (192.168.1.214)"
}
```

### Container Actions

```http
POST /api/swarm/containers/{container_id}/restart
POST /api/swarm/containers/{container_id}/stop
POST /api/swarm/containers/{container_id}/start
GET /api/swarm/containers/{container_id}/logs?tail=100
```

---

## Clusters API

Base: `/api/clusters`

### List Clusters

```http
GET /api/clusters/
```

**Response:**
```json
[
  {
    "id": "cluster-uuid",
    "name": "vision",
    "cluster_type": "swarm",
    "node_ids": ["agx0", "agx1", "agx2"],
    "manager_node_id": "agx0",
    "status": "active",
    "created_at": "2024-12-21T10:00:00Z"
  }
]
```

### Create Cluster

```http
POST /api/clusters/
```

**Request:**
```json
{
  "name": "vision",
  "cluster_type": "swarm",
  "node_ids": ["agx0", "agx1", "agx2"],
  "manager_node_id": "agx0"
}
```

### Get Cluster Status

```http
GET /api/clusters/{cluster_id}/status
```

**Response:**
```json
{
  "cluster": {...},
  "nodes": [
    {
      "node_id": "agx0",
      "status": "online",
      "cpu": 15.2,
      "memory": 45.8,
      "gpu": 0,
      "is_manager": true
    }
  ],
  "online_count": 3,
  "total_count": 3
}
```

### Add Node to Cluster

```http
POST /api/clusters/{cluster_id}/nodes/{node_id}
```

### Remove Node from Cluster

```http
DELETE /api/clusters/{cluster_id}/nodes/{node_id}
```

### Delete Cluster

```http
DELETE /api/clusters/{cluster_id}?cleanup_swarm=true
```

---

## Vision API (Smart Scheduler)

Base: `/api/vision`

The Vision API uses a **Smart Scheduler** that automatically:
1. Routes jobs to nodes with the requested model already loaded
2. Switches models on least-busy nodes if needed
3. Load balances across the vision cluster
4. Queues jobs when all nodes are busy

### Workflow Diagram

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Your App   │────>│  Fleet Commander │────>│  Vision Nodes   │
│  (Jessica)  │     │  Smart Scheduler │     │  (agx0-agx2)    │
└─────────────┘     └──────────────────┘     └─────────────────┘
      │                      │                       │
      │  POST /generate      │                       │
      │─────────────────────>│                       │
      │                      │  Find node with model │
      │                      │──────────────────────>│
      │  { job_id: "xxx" }   │                       │
      │<─────────────────────│                       │
      │                      │                       │
      │  GET /jobs/{job_id}  │                       │
      │─────────────────────>│  Poll for completion  │
      │                      │──────────────────────>│
      │  { status, result }  │                       │
      │<─────────────────────│                       │
      │                      │                       │
      │  GET /outputs/{file} │  Image from S3        │
      │<─────────────────────│<──────────────────────│
└─────────────────────────────────────────────────────────────┘
```

### Get Cluster Status

```http
GET /api/vision/status
```

**Response:**
```json
{
  "online_nodes": 3,
  "busy_nodes": 1,
  "switching_nodes": 0,
  "offline_nodes": 0,
  "queue_length": 2,
  "models_loaded": {
    "SDXL_4GB_FP8.safetensors": ["agx0", "agx1"],
    "RealVisXL_V5_Turbo.safetensors": ["agx2"]
  }
}
```

### Generate Image (Queue Job)

```http
POST /api/vision/generate
```

**Request:**
```json
{
  "prompt": "A beautiful sunset over mountains",
  "negative_prompt": "blurry, low quality",
  "width": 1024,
  "height": 1024,
  "steps": 20,
  "guidance_scale": 7.5,
  "seed": null,
  "model": "SDXL_4GB_FP8.safetensors",
  "lora": "detail_enhancer",
  "lora_strength": 0.8,
  "priority": 0
}
```

**Parameters:**
| Field | Type | Default | Description |
|-------|------|---------|-------------|
| prompt | string | required | Text prompt for generation |
| negative_prompt | string | "" | What to avoid |
| width | int | 1024 | Image width |
| height | int | 1024 | Image height |
| steps | int | 20 | Inference steps |
| guidance_scale | float | 7.5 | CFG scale |
| seed | int | null | Random seed (null = random) |
| model | string | "SDXL_4GB_FP8.safetensors" | Target model |
| lora | string | null | LoRA to apply |
| lora_strength | float | 0.8 | LoRA weight |
| priority | int | 0 | Higher = more priority |

**Response:**
```json
{
  "job_id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "queued",
  "queue_position": 1,
  "target_model": "SDXL_4GB_FP8.safetensors"
}
```

### Get Job Status

```http
GET /api/vision/jobs/{job_id}
```

**Response (Queued):**
```json
{
  "job_id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "queued",
  "queue_position": 2
}
```

**Response (Processing):**
```json
{
  "job_id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "processing",
  "progress": 45,
  "node_id": "agx0"
}
```

**Response (Completed):**
```json
{
  "job_id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "completed",
  "progress": 100,
  "result": {
    "image_url": "/api/vision/outputs/image_123.png",
    "seed": 42,
    "generation_time": 5.2,
    "node_id": "agx0"
  }
}
```

**Response (Failed):**
```json
{
  "job_id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "failed",
  "error": "Model loading failed"
}
```

### List All Jobs

```http
GET /api/vision/jobs?status=processing&limit=50
```

### Cancel Job

```http
POST /api/vision/jobs/{job_id}/cancel
```

### Stop All Jobs

```http
POST /api/vision/jobs/stop-all
```

### List Queue

```http
GET /api/vision/queue
```

### List Available Models

```http
GET /api/vision/models/available
```

**Response:**
```json
{
  "models": [
    {
      "name": "sdxl-turbo",
      "type": "checkpoint",
      "size": "6.5GB",
      "loaded_on": ["agx0"]
    }
  ]
}
```

### Switch Model on Node

```http
POST /api/vision/models/switch/{node_id}
```

**Request:**
```json
{
  "model": "sdxl-turbo"
}
```

### List LoRAs

```http
GET /api/vision/loras
```

### Upload LoRA

```http
POST /api/vision/loras/upload
Content-Type: multipart/form-data

file: <lora_file.safetensors>
name: my_lora
```

### Get Gallery

```http
GET /api/vision/gallery?limit=50&offset=0
```

### Get/Delete Outputs

```http
GET /api/vision/outputs
GET /api/vision/outputs/{filename}
DELETE /api/vision/outputs/{filename}
POST /api/vision/outputs/clear
```

### Available Schedulers

```http
GET /api/vision/schedulers
```

**Response:**
```json
{
  "schedulers": [
    "euler", "euler_a", "dpm++_2m", "dpm++_2m_karras",
    "ddim", "lms", "heun", "dpm_fast"
  ]
}
```

### Aspect Ratios

```http
GET /api/vision/aspect-ratios
```

**Response:**
```json
{
  "ratios": [
    {"name": "1:1", "width": 1024, "height": 1024},
    {"name": "16:9", "width": 1344, "height": 768},
    {"name": "9:16", "width": 768, "height": 1344}
  ]
}
```

---

## SSH API

Base: `/api/ssh`

### Execute Command on Node

```http
POST /api/ssh/exec-node
```

**Request:**
```json
{
  "node_id": "agx0",
  "command": "nvidia-smi"
}
```

**Response:**
```json
{
  "node_id": "agx0",
  "host": "192.168.1.182",
  "stdout": "...",
  "stderr": "",
  "exit_status": 0
}
```

---

## Network API

Base: `/api/network`

### Scan Network

```http
GET /api/network/scan?subnet=192.168.1.0/24&refresh=false
```

**Response:**
```json
{
  "devices": [
    {
      "ip": "192.168.1.182",
      "hostname": "agx0",
      "mac": "00:11:22:33:44:55",
      "vendor": "NVIDIA",
      "is_jetson": true,
      "in_swarm": true,
      "ports": [22, 8080]
    }
  ],
  "scan_time": "2024-12-21T17:30:00Z"
}
```

### Get Scan Status

```http
GET /api/network/scan-status
```

### Join Node to Swarm

```http
POST /api/network/join
```

**Request:**
```json
{
  "ip": "192.168.1.182",
  "credential_id": "cred-uuid"
}
```

### Auto-Join All Discovered Nodes

```http
POST /api/network/auto-join-all
```

---

## Build API

Base: `/api/build`

### List Registry Images

```http
GET /api/build/registry/images
```

**Response:**
```json
{
  "images": [
    {
      "name": "sdxl-trt",
      "tags": ["r35.3.1", "r35.2.1", "latest"],
      "full_image": "192.168.1.214:5000/sdxl-trt"
    }
  ],
  "registry": "192.168.1.214:5000"
}
```

### Build Image

```http
POST /api/build/build
```

**Request:**
```json
{
  "image_name": "my-service",
  "tag": "v1.0",
  "dockerfile_path": "/path/to/Dockerfile",
  "build_args": {
    "BASE_IMAGE": "nvcr.io/nvidia/l4t-pytorch:r35.2.1-pth2.0-py3"
  }
}
```

### Deploy Image

```http
POST /api/build/deploy
```

**Request:**
```json
{
  "image": "192.168.1.214:5000/my-service:v1.0",
  "service_name": "my-service",
  "cluster": "vision",
  "replicas": 1
}
```

### Build and Deploy

```http
POST /api/build/build-and-deploy
```

---

## Install Queue API

Base: `/api/install-queue`

### Add to Install Queue

```http
POST /api/install-queue/queue
```

**Request:**
```json
{
  "host": "192.168.1.182",
  "credential_id": "cred-uuid",
  "cluster": "vision"
}
```

### Get Queue Status

```http
GET /api/install-queue/queue
GET /api/install-queue/queue/{job_id}
```

### Retry Failed Jobs

```http
POST /api/install-queue/queue/{job_id}/retry
POST /api/install-queue/queue/retry-failed
```

### Clear Queue

```http
DELETE /api/install-queue/queue
```

---

## Maintenance API

Base: `/api/maintenance`

### Get Maintenance Status

```http
GET /api/maintenance/status
```

**Response:**
```json
{
  "enabled": true,
  "running": false,
  "last_run": "2024-12-21T06:00:00Z",
  "next_run": "2024-12-22T06:00:00Z",
  "problems_count": 2
}
```

### Get Problems

```http
GET /api/maintenance/problems
```

**Response:**
```json
{
  "problems": [
    {
      "id": "prob-uuid",
      "node_id": "agx2",
      "type": "disk_space",
      "severity": "warning",
      "message": "Disk usage at 85%",
      "detected_at": "2024-12-21T10:00:00Z",
      "auto_fixable": true
    }
  ]
}
```

### Start/Stop Maintenance

```http
POST /api/maintenance/start
POST /api/maintenance/stop
```

### Run Maintenance Now

```http
POST /api/maintenance/run-now
```

### Quick Fix

```http
POST /api/maintenance/quick-fix
```

**Request:**
```json
{
  "node_id": "agx2",
  "fix_type": "docker_cleanup"
}
```

### Disk Audit

```http
POST /api/maintenance/disk/audit
```

---

## Vault API

Base: `/api/vault`

### List Credentials

```http
GET /api/vault/
```

**Response:**
```json
[
  {
    "id": "cred-uuid",
    "name": "jetson-default",
    "username": "nvidia",
    "created_at": "2024-12-20T10:00:00Z"
  }
]
```

### Save Credential

```http
POST /api/vault/
```

**Request:**
```json
{
  "name": "jetson-default",
  "username": "nvidia",
  "password": "nvidia"
}
```

### Delete Credential

```http
DELETE /api/vault/{cred_id}
```

---

## AI API

Base: `/api/ai`

### Chat with AI Assistant

```http
POST /api/ai/chat
```

**Request:**
```json
{
  "message": "Why is agx0 showing high GPU temperature?",
  "context": {
    "node_id": "agx0"
  }
}
```

**Response:**
```json
{
  "response": "The high GPU temperature on agx0 could be due to...",
  "suggestions": [
    "Check fan speed",
    "Reduce workload"
  ]
}
```

### Troubleshoot Node

```http
POST /api/ai/troubleshoot
```

**Request:**
```json
{
  "node_id": "agx0",
  "issue": "container keeps restarting"
}
```

---

## WebSocket API

### Real-time Metrics

```
ws://192.168.1.214:8765/ws/metrics
```

**Message Format (Received):**
```json
{
  "type": "metrics",
  "nodes": {
    "agx0": {
      "cpu": 15.2,
      "memory": 45.8,
      "gpu": 25.0,
      "gpu_memory": 4096,
      "temperature": 52,
      "disk": 65.2,
      "status": "online"
    }
  },
  "timestamp": "2024-12-21T17:30:00Z"
}
```

### Node Logs Stream

```
ws://192.168.1.214:8765/ws/logs/{node_id}
```

**Message Format (Received):**
```json
{
  "type": "log",
  "node_id": "agx0",
  "timestamp": "2024-12-21T17:30:00Z",
  "level": "info",
  "message": "Container started successfully"
}
```

### Doctor/Health Stream

```
ws://192.168.1.214:8765/ws/doctor
```

---

## Integration Examples

### Python - Generate Image

```python
import httpx
import asyncio

API_URL = "http://192.168.1.214:8765/api"

async def generate_image(prompt: str):
    async with httpx.AsyncClient() as client:
        # Submit generation job
        resp = await client.post(f"{API_URL}/vision/generate", json={
            "prompt": prompt,
            "width": 1024,
            "height": 1024,
            "steps": 20
        })
        job = resp.json()
        job_id = job["job_id"]

        # Poll for completion
        while True:
            status = await client.get(f"{API_URL}/vision/jobs/{job_id}")
            data = status.json()

            if data["status"] == "completed":
                return data["result"]["image_url"]
            elif data["status"] == "failed":
                raise Exception(data.get("error", "Generation failed"))

            await asyncio.sleep(1)

# Usage
image_url = asyncio.run(generate_image("A beautiful sunset"))
print(f"Image: http://192.168.1.214:8765{image_url}")
```

### Python - Execute SSH Command

```python
import httpx

def run_on_node(node_id: str, command: str):
    resp = httpx.post(
        "http://192.168.1.214:8765/api/ssh/exec-node",
        json={"node_id": node_id, "command": command}
    )
    return resp.json()

# Check GPU on agx0
result = run_on_node("agx0", "nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader")
print(f"GPU Usage: {result['stdout']}")
```

### Python - WebSocket Metrics

```python
import asyncio
import websockets
import json

async def monitor_metrics():
    uri = "ws://192.168.1.214:8765/ws/metrics"
    async with websockets.connect(uri) as ws:
        while True:
            message = await ws.recv()
            data = json.loads(message)

            for node_id, metrics in data.get("nodes", {}).items():
                print(f"{node_id}: CPU={metrics['cpu']:.1f}% GPU={metrics['gpu']:.1f}%")

asyncio.run(monitor_metrics())
```

### JavaScript/Node.js - Deploy Service

```javascript
const axios = require('axios');

const API_URL = 'http://192.168.1.214:8765/api';

async function deployService(name, image, cluster) {
  const response = await axios.post(`${API_URL}/swarm/services`, {
    name: name,
    image: image,
    replicas: 1,
    mode: 'replicated',
    constraints: [
      `node.labels.cluster==${cluster}`,
      'node.labels.nvidia==true'
    ],
    resources: { gpu: 1 },
    mounts: [
      { source: '/mnt/s3-models', target: '/models' },
      { source: '/mnt/s3-outputs', target: '/outputs' }
    ]
  });

  return response.data;
}

// Deploy SDXL to vision cluster
deployService('vision-sdxl', '192.168.1.214:5000/sdxl-trt:r35.3.1', 'vision')
  .then(console.log)
  .catch(console.error);
```

### cURL - Quick Examples

```bash
# Get all nodes
curl http://192.168.1.214:8765/api/nodes/

# Get swarm status
curl http://192.168.1.214:8765/api/swarm/status

# Generate image
curl -X POST http://192.168.1.214:8765/api/vision/generate \
  -H "Content-Type: application/json" \
  -d '{"prompt": "A cat wearing a hat", "steps": 20}'

# Execute command on node
curl -X POST http://192.168.1.214:8765/api/ssh/exec-node \
  -H "Content-Type: application/json" \
  -d '{"node_id": "agx0", "command": "df -h"}'

# List registry images
curl http://192.168.1.214:8765/api/build/registry/images

# Create service
curl -X POST http://192.168.1.214:8765/api/swarm/services \
  -H "Content-Type: application/json" \
  -d '{
    "name": "test-service",
    "image": "nginx:latest",
    "replicas": 1,
    "ports": [{"target_port": 80, "published_port": 8080}]
  }'
```

---

## Error Responses

All endpoints return standard HTTP status codes:

| Code | Meaning |
|------|---------|
| 200 | Success |
| 201 | Created |
| 400 | Bad Request - Invalid parameters |
| 401 | Unauthorized - Invalid credentials |
| 404 | Not Found - Resource doesn't exist |
| 500 | Internal Server Error |
| 504 | Gateway Timeout - SSH/connection timeout |

**Error Response Format:**
```json
{
  "detail": "Error message describing what went wrong"
}
```

---

## Rate Limits

No rate limits currently enforced. For production use, consider implementing rate limiting.

---

## Service Ports Reference

| Service | Port | Description |
|---------|------|-------------|
| Fleet Commander API | 8765 | Main API server |
| MinIO S3 | 9010 | Object storage API |
| MinIO Console | 9011 | MinIO web UI |
| Docker Registry | 5000 | Container registry |
| Redis | 6379 | Cache/message broker |
| PostgreSQL | 5432 | Database |
| ComfyUI | 8188 | Image generation UI |
| SDXL-TRT | 8080 | TensorRT SDXL API |
| Chatterbox TTS | 8100 | Text-to-speech API |
| Bytebot | 9992 | AI Desktop Agent |

---

## S3 Buckets

| Bucket | Mount Point | Purpose |
|--------|-------------|---------|
| fleet-models | /mnt/s3-models | AI model files |
| fleet-outputs | /mnt/s3-outputs | Generated outputs |
| fleet-loras | /mnt/s3-loras | LoRA files |
| fleet-voices | /mnt/s3-voices | Voice reference files |
| fleet-workspace | /mnt/s3-workspace | Agent workspace |

---

## Support

- GitHub Issues: https://github.com/your-repo/issues
- Documentation: This file
