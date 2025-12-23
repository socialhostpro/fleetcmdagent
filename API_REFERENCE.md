# Fleet Commander API Reference

**Base URL:** `http://192.168.1.214:8765`

## Authentication
Currently no authentication required. Optional API key: `fleet-commander-2024`

---

## Quick Start - Image Generation

### Generate Image (Fastest - Direct to SDXL-TRT)
```bash
curl -X POST "http://192.168.1.214:8765/api/fleet/generate" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "a beautiful sunset over mountains",
    "negative_prompt": "blurry, bad quality",
    "width": 1024,
    "height": 1024,
    "steps": 20,
    "guidance_scale": 7.5
  }' \
  --output image.png
```

### Check Generation Status
```bash
curl "http://192.168.1.214:8765/api/fleet/generate/status"
```

---

## Connection Endpoints

### Connect/Health Check
```
POST /api/fleet/connect
GET  /api/fleet/connect
GET  /api/fleet/status
GET  /api/fleet/capabilities
GET  /health
GET  /api/status
```

**Example:**
```bash
curl -X POST "http://192.168.1.214:8765/api/fleet/connect" \
  -H "Content-Type: application/json" \
  -d '{"api_key": "fleet-commander-2024"}'
```

**Response:**
```json
{
  "status": "connected",
  "message": "Successfully connected to Fleet Commander",
  "version": "1.0.0",
  "capabilities": ["nodes", "containers", "images", "generation", "ssh", "metrics", "vision"]
}
```

---

## Image Generation APIs

### 1. Direct SDXL-TRT (Synchronous - Returns PNG)

**POST /api/fleet/generate**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| prompt | string | required | Text prompt |
| negative_prompt | string | "blurry, bad quality" | Negative prompt |
| width | int | 1024 | Image width |
| height | int | 1024 | Image height |
| steps | int | 20 | Inference steps |
| guidance_scale | float | 7.5 | CFG scale |
| seed | int | null | Random seed |

**Response:** PNG image stream with headers:
- `X-Seed`: Seed used
- `X-Filename`: Generated filename

---

### 2. Vision Scheduler (Queue-based with model routing)

**POST /api/vision/generate**

Queues job and routes to best available node based on model.

```bash
curl -X POST "http://192.168.1.214:8765/api/vision/generate" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "cyberpunk city at night",
    "model": "SDXL_4GB_FP8.safetensors",
    "width": 1024,
    "height": 1024,
    "steps": 20,
    "priority": 0
  }'
```

**Response:**
```json
{
  "job_id": "uuid-here",
  "status": "queued",
  "queue_position": 1,
  "target_model": "SDXL_4GB_FP8.safetensors"
}
```

**Get Job Status:**
```bash
curl "http://192.168.1.214:8765/api/vision/jobs/{job_id}"
```

---

### 3. Job Queue System (Most Flexible)

**POST /api/queue/jobs**

Full job queue with priorities, callbacks, and retries.

```bash
curl -X POST "http://192.168.1.214:8765/api/queue/jobs" \
  -H "Content-Type: application/json" \
  -d '{
    "job_type": "image_gen",
    "priority": "high",
    "payload": {
      "prompt": "beautiful landscape",
      "width": 1024,
      "height": 1024
    },
    "target_cluster": "vision",
    "callback_url": "https://your-app.com/webhook",
    "max_retries": 3,
    "timeout_seconds": 3600
  }'
```

**Job Types:** `image_gen`, `video_gen`, `llm_inference`, `transcription`, `training`, `custom`

**Priorities:** `high`, `normal`, `low`

**Queue Endpoints:**
```
GET  /api/queue/jobs              # List all jobs
GET  /api/queue/jobs/{job_id}     # Get job status
DELETE /api/queue/jobs/{job_id}   # Cancel job
POST /api/queue/jobs/{job_id}/retry  # Retry failed job
GET  /api/queue/stats             # Queue statistics
POST /api/queue/jobs/batch        # Create multiple jobs
```

---

## ComfyUI API (Advanced Workflows)

**Base URL:** `http://192.168.1.214:8188`

### Queue Workflow
```bash
curl -X POST "http://192.168.1.214:8188/prompt" \
  -H "Content-Type: application/json" \
  -d '{"prompt": {...workflow_json...}}'
```

### Get Queue Status
```bash
curl "http://192.168.1.214:8188/queue"
```

### Get History
```bash
curl "http://192.168.1.214:8188/history"
```

### Get Available Nodes
```bash
curl "http://192.168.1.214:8188/object_info"
```

### WebSocket (Real-time updates)
```javascript
const ws = new WebSocket('ws://192.168.1.214:8188/ws');
ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  if (data.type === 'progress') {
    console.log(`Progress: ${data.data.value}/${data.data.max}`);
  }
  if (data.type === 'executed') {
    console.log('Generation complete:', data.data);
  }
};
```

---

## S3/MinIO Storage

**Endpoint:** `http://192.168.1.214:9010`
**Console:** `http://192.168.1.214:9011`
**Access Key:** `minioadmin`
**Secret Key:** `minioadmin123`

### Buckets
| Bucket | Purpose | Public |
|--------|---------|--------|
| `fleet-models` | Checkpoint models | No |
| `fleet-outputs` | Generated images/videos | Yes |
| `fleet-loras` | LoRA models | No |
| `fleet-workspace` | Temp workspace | No |

### Direct URL Access (Public Outputs)
```
http://192.168.1.214:9010/fleet-outputs/{filename}
```

### Python Example
```python
import boto3

s3 = boto3.client(
    's3',
    endpoint_url='http://192.168.1.214:9010',
    aws_access_key_id='minioadmin',
    aws_secret_access_key='minioadmin123'
)

# List outputs
response = s3.list_objects_v2(Bucket='fleet-outputs')
for obj in response.get('Contents', []):
    print(obj['Key'])

# Upload file
s3.upload_file('local.png', 'fleet-outputs', 'remote.png')

# Download file
s3.download_file('fleet-outputs', 'image.png', 'local.png')
```

---

## Node Management

### List All Nodes
```bash
curl "http://192.168.1.214:8765/api/nodes"
```

### Get Node Details
```bash
curl "http://192.168.1.214:8765/api/nodes/{node_id}"
```

### Vision Cluster Nodes
```bash
curl "http://192.168.1.214:8765/api/vision/nodes"
```

### Node Heartbeats (GPU metrics)
```bash
curl "http://192.168.1.214:8765/api/nodes/heartbeats"
```

---

## Container Deployment

### Deploy Container to Node
```bash
curl -X POST "http://192.168.1.214:8765/api/fleet/deploy" \
  -H "Content-Type: application/json" \
  -d '{
    "node_id": "agx0",
    "image": "192.168.1.214:5000/myapp:latest",
    "name": "myapp",
    "port": 8080,
    "host_port": 8080,
    "gpus": true,
    "mounts": ["/mnt/s3-models:/models"]
  }'
```

### Remove Container
```bash
curl -X DELETE "http://192.168.1.214:8765/api/fleet/deploy/{node_id}/{container_name}"
```

### Execute Command on Node
```bash
curl -X POST "http://192.168.1.214:8765/api/fleet/exec/{node_id}" \
  -H "Content-Type: application/json" \
  -d '{"command": "nvidia-smi"}'
```

### Get Container Logs
```bash
curl "http://192.168.1.214:8765/api/fleet/logs/{node_id}/{container_name}?tail=100"
```

---

## Swarm Services

### List Services
```bash
curl "http://192.168.1.214:8765/api/swarm/services"
```

### Get Service Details
```bash
curl "http://192.168.1.214:8765/api/swarm/services/{service_id}"
```

### Scale Service
```bash
curl -X POST "http://192.168.1.214:8765/api/swarm/services/{service_id}/scale?replicas=4"
```

---

## Gallery & Outputs

### List Generated Images
```bash
curl "http://192.168.1.214:8765/api/vision/gallery?limit=100"
```

### Get Output Image
```bash
curl "http://192.168.1.214:8765/api/vision/outputs/{filename}" --output image.png
```

### Delete Output
```bash
curl -X DELETE "http://192.168.1.214:8765/api/vision/outputs/{filename}"
```

---

## Available Models

### List Checkpoint Models
```bash
curl "http://192.168.1.214:8765/api/vision/models/available"
```

### List LoRAs
```bash
curl "http://192.168.1.214:8765/api/vision/loras"
```

### Currently Loaded Models
```bash
curl "http://192.168.1.214:8765/api/vision/models/loaded"
```

---

## WebSocket Events

**URL:** `ws://192.168.1.214:8765/ws`

### Event Types
```json
{"type": "node_update", "data": {...}}
{"type": "job_progress", "data": {"job_id": "...", "progress": 50}}
{"type": "job_complete", "data": {"job_id": "...", "result": {...}}}
{"type": "service_update", "data": {...}}
```

### JavaScript Example
```javascript
const ws = new WebSocket('ws://192.168.1.214:8765/ws');

ws.onopen = () => {
  console.log('Connected to Fleet Commander');
};

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  console.log('Event:', msg.type, msg.data);
};
```

---

## Python SDK Example

```python
import requests
import io
from PIL import Image

BASE_URL = "http://192.168.1.214:8765"

class FleetCommander:
    def __init__(self, base_url=BASE_URL):
        self.base_url = base_url
        self.session = requests.Session()

    def connect(self):
        """Test connection"""
        resp = self.session.get(f"{self.base_url}/api/fleet/connect")
        return resp.json()

    def generate_image(self, prompt, **kwargs):
        """Generate image and return PIL Image"""
        params = {
            "prompt": prompt,
            "negative_prompt": kwargs.get("negative_prompt", "blurry, bad quality"),
            "width": kwargs.get("width", 1024),
            "height": kwargs.get("height", 1024),
            "steps": kwargs.get("steps", 20),
            "guidance_scale": kwargs.get("guidance_scale", 7.5),
            "seed": kwargs.get("seed"),
        }
        resp = self.session.post(
            f"{self.base_url}/api/fleet/generate",
            json=params
        )
        resp.raise_for_status()
        return Image.open(io.BytesIO(resp.content))

    def queue_job(self, prompt, priority="normal", callback_url=None):
        """Queue a job for async processing"""
        resp = self.session.post(
            f"{self.base_url}/api/queue/jobs",
            json={
                "job_type": "image_gen",
                "priority": priority,
                "payload": {"prompt": prompt},
                "callback_url": callback_url
            }
        )
        return resp.json()

    def get_job(self, job_id):
        """Get job status"""
        resp = self.session.get(f"{self.base_url}/api/queue/jobs/{job_id}")
        return resp.json()

    def list_nodes(self):
        """List all cluster nodes"""
        resp = self.session.get(f"{self.base_url}/api/nodes")
        return resp.json()

    def get_gallery(self, limit=50):
        """Get generated images"""
        resp = self.session.get(f"{self.base_url}/api/vision/gallery?limit={limit}")
        return resp.json()


# Usage
fleet = FleetCommander()
print(fleet.connect())

# Generate image
image = fleet.generate_image("a cyberpunk city at night")
image.save("output.png")

# Or queue job with callback
job = fleet.queue_job("beautiful landscape", priority="high",
                       callback_url="https://myapp.com/webhook")
print(f"Job ID: {job['job_id']}")
```

---

## Network Info

| Service | IP | Port | Description |
|---------|-----|------|-------------|
| Fleet Commander API | 192.168.1.214 | 8765 | Main API |
| ComfyUI | 192.168.1.214 | 8188 | Advanced workflows |
| MinIO S3 | 192.168.1.214 | 9010 | Object storage |
| MinIO Console | 192.168.1.214 | 9011 | Web UI |
| Redis | 192.168.1.214 | 6379 | Job queue |
| Registry | 192.168.1.214 | 5000 | Docker registry |
| SDXL-TRT Workers | Various | 8080 | GPU inference |

---

## Output Management

All generated outputs are automatically synced to S3 every 15 minutes. Local files older than 24 hours are cleaned up.

### Output Stats
```bash
curl "http://192.168.1.214:8765/api/outputs/stats"
```

### List Outputs
```bash
# From S3
curl "http://192.168.1.214:8765/api/outputs/list?source=s3&limit=100"

# From local (if available)
curl "http://192.168.1.214:8765/api/outputs/list?source=local"
```

### Manual Sync to S3
```bash
curl -X POST "http://192.168.1.214:8765/api/outputs/sync"
```

### Cleanup Local Files
```bash
# Dry run - see what would be deleted
curl -X POST "http://192.168.1.214:8765/api/outputs/cleanup?max_age_hours=24&dry_run=true"

# Actually delete
curl -X POST "http://192.168.1.214:8765/api/outputs/cleanup?max_age_hours=24"
```

### Move All to S3 (and delete local)
```bash
curl -X POST "http://192.168.1.214:8765/api/outputs/move-all-to-s3"
```

### Direct S3 Output URLs
```
Base: http://192.168.1.214:9010/fleet-outputs/
ComfyUI: http://192.168.1.214:9010/fleet-outputs/comfyui/
AnimateDiff: http://192.168.1.214:9010/fleet-outputs/animatediff/
```

---

## Error Handling

All endpoints return JSON errors:
```json
{
  "detail": "Error message here"
}
```

HTTP Status Codes:
- `200` - Success
- `400` - Bad request
- `404` - Not found
- `500` - Server error
- `503` - Service unavailable
- `504` - Timeout

---

## Rate Limits

Currently no rate limits. Queue system handles load distribution automatically.
