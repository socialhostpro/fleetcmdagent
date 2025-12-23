# Fleet Commander - Shared Docker Images Implementation Plan

**Status: IMPLEMENTED**
**Last Updated: 2025-12-18**

## Goal
AGX nodes should NOT store Docker images locally. Images are built and stored on Spark.
AGX nodes load images into memory from Spark's S3 storage when deploying.

## Architecture

```
SPARK (192.168.1.214)                    AGX NODES (agx0, agx1, agx2)
┌──────────────────────┐                 ┌──────────────────────┐
│ Docker builds here   │                 │ NO local images      │
│ Images stored in S3  │    MinIO S3    │ Load from S3         │
│ fleet-docker-images  │ ──────────────▶│ /mnt/s3-docker       │
│                      │                 │                      │
│ Registry: 5000       │                 │ docker load < .tar   │
│ MinIO: 9010          │                 │                      │
└──────────────────────┘                 └──────────────────────┘
```

## Implementation Complete

### S3 Storage (MinIO)
- Bucket: `fleet-docker-images` - Stores Docker image tarballs
- AGX nodes mount via s3fs to `/mnt/s3-docker`
- Images can be streamed directly or loaded from mount

### API Endpoints
- `GET /api/images/` - List all images in S3
- `POST /api/images/save` - Save image from Spark to S3
- `POST /api/images/load` - Load image from S3 to AGX node
- `GET /api/images/task/{task_id}` - Get task status
- `DELETE /api/images/{name}` - Delete image from S3

### Scripts Created
- `bootstrap/image-manager/save-image.sh` - Save Docker image to S3
- `bootstrap/image-manager/load-image.sh` - Load image on AGX node
- `bootstrap/image-manager/list-images.sh` - List available images

### Bootstrap Updated
- `/mnt/s3-docker` mount added to bootstrap-node.sh
- `fleet-load-image.sh` installed on nodes

## Current S3 Mounts (All Working)
- `/mnt/s3-models` - AI models (fleet-models bucket)
- `/mnt/s3-outputs` - Generated outputs (fleet-outputs bucket)
- `/mnt/s3-loras` - LoRA files (fleet-loras bucket)
- `/mnt/s3-docker` - Docker images (fleet-docker-images bucket)

## Commands Reference

### Save image from Spark to S3:
```bash
# Using script
./bootstrap/image-manager/save-image.sh dustynv/comfyui:r36.4.0 comfyui-r36.4.0

# Using API
curl -X POST http://192.168.1.214:8765/api/images/save \
  -H "Content-Type: application/json" \
  -d '{"image": "dustynv/comfyui:r36.4.0", "name": "comfyui-r36.4.0"}'
```

### List images in S3:
```bash
curl http://192.168.1.214:8765/api/images/
```

### Load image on AGX node:
```bash
# Using script (on node)
fleet-load-image.sh comfyui-r36.4.0

# Using API (from anywhere)
curl -X POST http://192.168.1.214:8765/api/images/load \
  -H "Content-Type: application/json" \
  -d '{"image_name": "comfyui-r36.4.0", "node_ip": "192.168.1.191", "credential_id": "your-cred-id"}'
```

### Cleanup AGX node (safe - images reload from S3):
```bash
docker image prune -af
```

## Discovery Page Updates
- Added "NOT INSTALLED" badge for AGX/Linux nodes without Fleet Agent
- Added filter for uninstalled nodes
- Yellow border highlighting for nodes that can be bootstrapped
