# Fleet Commander - Windows GPU Node Setup

Add your Windows PC with NVIDIA GPU (RTX 3060, 3090, etc.) to the Fleet Commander cluster.

## Requirements

- **OS**: Windows 10 (1903+) or Windows 11
- **GPU**: NVIDIA RTX 3060, 3090, or any CUDA-capable GPU
- **Software**:
  - Docker Desktop with WSL2 backend
  - NVIDIA drivers (latest)
  - WSL2 installed

## Quick Start

### 1. Install Prerequisites

1. **Install WSL2** (if not already installed):
   ```powershell
   wsl --install
   ```
   Restart your computer after installation.

2. **Install Docker Desktop**:
   - Download from: https://www.docker.com/products/docker-desktop/
   - Enable "Use the WSL 2 based engine" in Settings
   - Enable GPU support in Settings > Resources > GPU

3. **Install NVIDIA Drivers**:
   - Download from: https://www.nvidia.com/Download/index.aspx
   - Restart after installation

### 2. Run Setup Script

Right-click `setup-windows-node.bat` and select **Run as administrator**.

The script will:
1. Check all prerequisites
2. Configure Docker for the Fleet registry
3. Join the Docker Swarm cluster
4. Register the node with Fleet Commander
5. Optionally deploy GPU containers

### 3. Deploy Containers

Run `deploy-gpu-containers.bat` to deploy image generation containers:

- **SDXL-TRT**: TensorRT-accelerated Stable Diffusion XL
- **ComfyUI**: Node-based image generation UI
- **WAN Server**: Network relay for remote access

## Manual Setup

### Join Swarm Manually

```powershell
# Get join token from Fleet Commander
$token = (Invoke-RestMethod "http://192.168.1.214:8765/api/swarm/join-token?role=worker").token

# Join the swarm
docker swarm join --token $token 192.168.1.214:2377
```

### Deploy Containers Manually

```powershell
# SDXL TensorRT
docker run -d --name sdxl-trt --gpus all -p 8080:8080 `
  -v C:\ai-models:/models -v C:\ai-outputs:/outputs `
  192.168.1.214:5000/sdxl-trt:latest

# ComfyUI
docker run -d --name comfyui --gpus all -p 8188:8188 `
  -v C:\ai-models\checkpoints:/workspace/ComfyUI/models/checkpoints `
  -v C:\ai-outputs:/workspace/ComfyUI/output `
  ghcr.io/ai-dock/comfyui:pytorch-2.1.2-py3.10-cuda-12.1.0-runtime-22.04
```

## GPU Memory Recommendations

| GPU | VRAM | Recommended Model | Max Batch |
|-----|------|-------------------|-----------|
| RTX 3090 | 24GB | SDXL Base 1.0 | 4 |
| RTX 3080 | 10GB | SDXL Turbo | 2 |
| RTX 3060 | 12GB | SDXL FP8 | 2 |
| RTX 3060 | 8GB | SD 1.5 | 1 |

## Ports

| Service | Port | URL |
|---------|------|-----|
| SDXL-TRT | 8080 | http://localhost:8080 |
| ComfyUI | 8188 | http://localhost:8188 |
| WAN Server | 8000 | http://localhost:8000 |

## Troubleshooting

### "Docker Desktop is not running"
Start Docker Desktop from the Start menu.

### "NVIDIA Container Toolkit not configured"
1. Open Docker Desktop Settings
2. Go to Resources > GPU
3. Enable "Enable GPU access"
4. Restart Docker Desktop

### "Cannot connect to Fleet Commander"
1. Check that Fleet Commander is running at 192.168.1.214
2. Ensure your Windows PC is on the same network
3. Check Windows Firewall isn't blocking port 8765

### Container fails to start
```powershell
# Check logs
docker logs sdxl-trt

# Check GPU access
docker run --rm --gpus all nvidia/cuda:12.0-base-ubuntu22.04 nvidia-smi
```

## Directory Structure

```
C:\ai-models\
├── checkpoints\     # Model files (.safetensors, .ckpt)
├── loras\           # LoRA files
├── vae\             # VAE files
└── embeddings\      # Textual inversions

C:\ai-outputs\
├── images\          # Generated images
└── videos\          # Generated videos
```

## Downloading Models

Download models from:
- https://civitai.com
- https://huggingface.co

Place checkpoint files in `C:\ai-models\checkpoints\`

## Network Configuration

If using Fleet Commander's S3 storage for models:

1. Install s3fs-fuse via WSL:
   ```bash
   sudo apt install s3fs
   ```

2. Mount S3 buckets:
   ```bash
   s3fs fleet-models /mnt/s3-models -o passwd_file=/etc/passwd-s3fs,url=http://192.168.1.214:9010,use_path_request_style
   ```

3. Map network drive in Windows to access models from Linux containers.
