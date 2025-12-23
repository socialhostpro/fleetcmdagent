# Fleet Commander - Deploy GPU Containers on Windows
# Optimized for RTX 3060 (12GB) and RTX 3090 (24GB)

param(
    [string]$RegistryUrl = "192.168.1.214:5000",
    [string]$PortainerServer = "192.168.1.214",
    [string]$ModelsPath = "C:\ai-models",
    [string]$OutputsPath = "C:\ai-outputs",
    [switch]$SDXL,
    [switch]$ComfyUI,
    [switch]$WANVideo,
    [switch]$PortainerAgent,
    [switch]$All
)

$ErrorActionPreference = "Stop"

Write-Host @"
===============================================
  Fleet Commander - GPU Container Deployment
  Registry: $RegistryUrl
  Models: $ModelsPath
  Outputs: $OutputsPath
===============================================
"@ -ForegroundColor Cyan

# Check GPU memory to recommend configurations
function Get-GPUConfig {
    $gpuInfo = nvidia-smi --query-gpu=name,memory.total --format=csv,noheader
    $gpuName = ($gpuInfo -split ",")[0].Trim()
    $gpuMemoryStr = ($gpuInfo -split ",")[1].Trim()
    $gpuMemoryMB = [int]($gpuMemoryStr -replace '[^0-9]', '')

    Write-Host "`nDetected GPU: $gpuName ($gpuMemoryStr)" -ForegroundColor Cyan

    # Return recommended settings based on GPU
    if ($gpuMemoryMB -ge 20000) {
        # RTX 3090, 4090, A6000
        return @{
            GPUName = $gpuName
            Memory = $gpuMemoryMB
            SDXLModel = "SDXL_BASE_1.0.safetensors"
            ComfyModel = "sd_xl_base_1.0.safetensors"
            MaxBatchSize = 4
            Tier = "high"
        }
    } elseif ($gpuMemoryMB -ge 10000) {
        # RTX 3060 12GB, RTX 3080, RTX 4070
        return @{
            GPUName = $gpuName
            Memory = $gpuMemoryMB
            SDXLModel = "SDXL_4GB_FP8.safetensors"
            ComfyModel = "sdxl_turbo.safetensors"
            MaxBatchSize = 2
            Tier = "medium"
        }
    } else {
        # RTX 3060 8GB, RTX 2080
        return @{
            GPUName = $gpuName
            Memory = $gpuMemoryMB
            SDXLModel = "SD15_4GB.safetensors"
            ComfyModel = "v1-5-pruned.safetensors"
            MaxBatchSize = 1
            Tier = "low"
        }
    }
}

# Create necessary directories
function Initialize-Directories {
    Write-Host "`nInitializing directories..." -ForegroundColor Yellow

    @($ModelsPath, $OutputsPath, "$ModelsPath\checkpoints", "$ModelsPath\loras", "$ModelsPath\vae") | ForEach-Object {
        if (-not (Test-Path $_)) {
            New-Item -ItemType Directory -Path $_ -Force | Out-Null
            Write-Host "  Created: $_" -ForegroundColor Green
        }
    }
}

# Deploy SDXL TensorRT container
function Deploy-SDXL {
    param([hashtable]$GPUConfig)

    Write-Host "`n[SDXL-TRT] Deploying SDXL TensorRT..." -ForegroundColor Yellow

    $containerName = "sdxl-trt"
    $image = "${RegistryUrl}/sdxl-trt:latest"
    $port = 8080

    # Stop existing
    docker stop $containerName 2>&1 | Out-Null
    docker rm $containerName 2>&1 | Out-Null

    Write-Host "  Pulling image..." -ForegroundColor Yellow
    docker pull $image

    Write-Host "  Starting container..." -ForegroundColor Yellow

    $envVars = @(
        "-e", "CUDA_VISIBLE_DEVICES=0",
        "-e", "MODEL=$($GPUConfig.SDXLModel)",
        "-e", "MAX_BATCH_SIZE=$($GPUConfig.MaxBatchSize)"
    )

    $volumes = @(
        "-v", "${ModelsPath}:/models",
        "-v", "${OutputsPath}:/outputs"
    )

    docker run -d `
        --name $containerName `
        --gpus all `
        -p ${port}:${port} `
        $envVars `
        $volumes `
        --restart unless-stopped `
        $image

    if ($LASTEXITCODE -eq 0) {
        Write-Host "  SDXL-TRT running at http://localhost:$port" -ForegroundColor Green
        Write-Host "  Recommended model for your GPU: $($GPUConfig.SDXLModel)" -ForegroundColor Cyan
    } else {
        Write-Host "  Failed to start SDXL-TRT" -ForegroundColor Red
    }
}

# Deploy ComfyUI container
function Deploy-ComfyUI {
    param([hashtable]$GPUConfig)

    Write-Host "`n[ComfyUI] Deploying ComfyUI..." -ForegroundColor Yellow

    $containerName = "comfyui"
    $image = "ghcr.io/ai-dock/comfyui:pytorch-2.1.2-py3.10-cuda-12.1.0-runtime-22.04"
    $port = 8188

    # Stop existing
    docker stop $containerName 2>&1 | Out-Null
    docker rm $containerName 2>&1 | Out-Null

    Write-Host "  Pulling image (this may take a while)..." -ForegroundColor Yellow
    docker pull $image

    Write-Host "  Starting container..." -ForegroundColor Yellow

    $volumes = @(
        "-v", "${ModelsPath}\checkpoints:/workspace/ComfyUI/models/checkpoints",
        "-v", "${ModelsPath}\loras:/workspace/ComfyUI/models/loras",
        "-v", "${ModelsPath}\vae:/workspace/ComfyUI/models/vae",
        "-v", "${OutputsPath}:/workspace/ComfyUI/output"
    )

    docker run -d `
        --name $containerName `
        --gpus all `
        -p ${port}:${port} `
        -e COMFYUI_PORT=$port `
        -e CLI_ARGS="--listen 0.0.0.0" `
        $volumes `
        --restart unless-stopped `
        $image

    if ($LASTEXITCODE -eq 0) {
        Write-Host "  ComfyUI running at http://localhost:$port" -ForegroundColor Green
        Write-Host "  Place models in: $ModelsPath\checkpoints" -ForegroundColor Cyan
    } else {
        Write-Host "  Failed to start ComfyUI" -ForegroundColor Red
    }
}

# Deploy WAN 2.1/2.5 Video Generation
function Deploy-WANVideo {
    param([hashtable]$GPUConfig)

    Write-Host "`n[WAN Video] Deploying WAN 2.1/2.5 Video Generation..." -ForegroundColor Yellow

    # WAN 2.1 requires 24GB+ VRAM for full model, 12GB for quantized
    if ($GPUConfig.Memory -lt 10000) {
        Write-Host "  WARNING: WAN Video requires at least 12GB VRAM" -ForegroundColor Red
        Write-Host "  Your GPU has $($GPUConfig.Memory)MB - may not work properly" -ForegroundColor Yellow
    }

    $containerName = "wan-video"
    # Use ai-dock's ComfyUI with WAN nodes pre-installed
    $image = "ghcr.io/ai-dock/comfyui:pytorch-2.4.0-py3.11-cuda-12.4.1-runtime-22.04"
    $port = 8189

    # Stop existing
    docker stop $containerName 2>&1 | Out-Null
    docker rm $containerName 2>&1 | Out-Null

    Write-Host "  Pulling image (large download)..." -ForegroundColor Yellow
    docker pull $image

    Write-Host "  Starting WAN Video container..." -ForegroundColor Yellow

    # Create video models directory
    $videoModelsPath = "$ModelsPath\video"
    if (-not (Test-Path $videoModelsPath)) {
        New-Item -ItemType Directory -Path $videoModelsPath -Force | Out-Null
    }

    $volumes = @(
        "-v", "${ModelsPath}\checkpoints:/workspace/ComfyUI/models/checkpoints",
        "-v", "${ModelsPath}\video:/workspace/ComfyUI/models/wan",
        "-v", "${ModelsPath}\loras:/workspace/ComfyUI/models/loras",
        "-v", "${OutputsPath}:/workspace/ComfyUI/output"
    )

    # Determine model based on VRAM
    $wanModel = if ($GPUConfig.Memory -ge 20000) { "wan2.1-t2v-14b" } else { "wan2.1-t2v-1.3b" }

    docker run -d `
        --name $containerName `
        --gpus all `
        -p ${port}:8188 `
        -e COMFYUI_PORT=8188 `
        -e CLI_ARGS="--listen 0.0.0.0 --highvram" `
        -e PROVISIONING_SCRIPT="https://raw.githubusercontent.com/ai-dock/comfyui/main/config/provisioning/wan.sh" `
        $volumes `
        --restart unless-stopped `
        $image

    if ($LASTEXITCODE -eq 0) {
        Write-Host "  WAN Video running at http://localhost:$port" -ForegroundColor Green
        Write-Host "  Recommended WAN model: $wanModel" -ForegroundColor Cyan
        Write-Host "" -ForegroundColor White
        Write-Host "  Download WAN models from:" -ForegroundColor Yellow
        Write-Host "    - WAN 2.1 T2V: https://huggingface.co/Wan-AI/Wan2.1-T2V-14B" -ForegroundColor White
        Write-Host "    - WAN 2.5 I2V: https://huggingface.co/Wan-AI/Wan2.5-I2V-14B-480P" -ForegroundColor White
        Write-Host "  Place in: $videoModelsPath" -ForegroundColor White
    } else {
        Write-Host "  Failed to start WAN Video" -ForegroundColor Red
    }
}

# Deploy Portainer Agent
function Deploy-PortainerAgent {
    Write-Host "`n[Portainer] Deploying Portainer Agent..." -ForegroundColor Yellow

    $containerName = "portainer_agent"
    $image = "portainer/agent:latest"
    $port = 9001

    # Stop existing
    docker stop $containerName 2>&1 | Out-Null
    docker rm $containerName 2>&1 | Out-Null

    Write-Host "  Pulling Portainer Agent..." -ForegroundColor Yellow
    docker pull $image

    Write-Host "  Starting Portainer Agent..." -ForegroundColor Yellow

    # Portainer agent needs access to Docker socket
    docker run -d `
        --name $containerName `
        -p ${port}:9001 `
        -v //var/run/docker.sock:/var/run/docker.sock `
        -v //var/lib/docker/volumes:/var/lib/docker/volumes `
        --restart always `
        $image

    if ($LASTEXITCODE -eq 0) {
        Write-Host "  Portainer Agent running on port $port" -ForegroundColor Green
        Write-Host "  Add this node in Portainer: http://${PortainerServer}:9443" -ForegroundColor Cyan
        Write-Host "  Use endpoint: $env:COMPUTERNAME:$port" -ForegroundColor White
    } else {
        Write-Host "  Failed to start Portainer Agent" -ForegroundColor Red
    }
}

# Show container status
function Show-ContainerStatus {
    Write-Host "`n===============================================" -ForegroundColor Cyan
    Write-Host "  Container Status" -ForegroundColor Green
    Write-Host "===============================================" -ForegroundColor Cyan

    docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}" --filter "name=sdxl-trt" --filter "name=comfyui" --filter "name=wan-video" --filter "name=portainer_agent"

    Write-Host "`nGPU Usage:" -ForegroundColor Yellow
    nvidia-smi --query-gpu=name,memory.used,memory.total,utilization.gpu --format=csv,noheader

    Write-Host "`nEndpoints:" -ForegroundColor Yellow
    $containers = docker ps --format "{{.Names}}:{{.Ports}}" --filter "name=sdxl-trt" --filter "name=comfyui" --filter "name=wan-video" --filter "name=portainer_agent"
    foreach ($container in $containers) {
        $parts = $container -split ":"
        $name = $parts[0]
        $portInfo = ($container -split "->")[0] -replace ".*:", ""
        if ($portInfo) {
            Write-Host "  $name : http://localhost:$portInfo" -ForegroundColor Cyan
        }
    }

    Write-Host "`nPortainer Dashboard:" -ForegroundColor Yellow
    Write-Host "  https://${PortainerServer}:9443" -ForegroundColor Cyan
}

# Main execution
try {
    $gpuConfig = Get-GPUConfig
    Initialize-Directories

    Write-Host "`nGPU Tier: $($gpuConfig.Tier.ToUpper())" -ForegroundColor $(
        switch ($gpuConfig.Tier) {
            "high" { "Green" }
            "medium" { "Yellow" }
            "low" { "Red" }
        }
    )

    if ($All) {
        $SDXL = $true
        $ComfyUI = $true
        $WANVideo = $true
        $PortainerAgent = $true
    }

    # If no flags specified, show menu
    if (-not $SDXL -and -not $ComfyUI -and -not $WANVideo -and -not $PortainerAgent) {
        Write-Host "`nSelect containers to deploy:" -ForegroundColor Yellow
        Write-Host "  [1] SDXL-TRT - TensorRT accelerated image generation" -ForegroundColor White
        Write-Host "  [2] ComfyUI - Node-based image generation UI" -ForegroundColor White
        Write-Host "  [3] WAN Video - WAN 2.1/2.5 Video generation with audio" -ForegroundColor White
        Write-Host "  [4] Portainer Agent - Remote management (RECOMMENDED)" -ForegroundColor White
        Write-Host "  [A] All containers" -ForegroundColor White
        Write-Host "  [Q] Quit" -ForegroundColor White

        $choice = Read-Host "`nChoice (comma-separated for multiple, e.g., 1,3,4)"

        $choices = $choice.ToUpper() -split ","
        foreach ($c in $choices) {
            switch ($c.Trim()) {
                "1" { $SDXL = $true }
                "2" { $ComfyUI = $true }
                "3" { $WANVideo = $true }
                "4" { $PortainerAgent = $true }
                "A" { $SDXL = $true; $ComfyUI = $true; $WANVideo = $true; $PortainerAgent = $true }
                "Q" { exit 0 }
            }
        }
    }

    # Always deploy Portainer Agent first for management
    if ($PortainerAgent) { Deploy-PortainerAgent }
    if ($SDXL) { Deploy-SDXL -GPUConfig $gpuConfig }
    if ($ComfyUI) { Deploy-ComfyUI -GPUConfig $gpuConfig }
    if ($WANVideo) { Deploy-WANVideo -GPUConfig $gpuConfig }

    Start-Sleep -Seconds 3
    Show-ContainerStatus

    Write-Host "`nDeployment complete!" -ForegroundColor Green

} catch {
    Write-Host "`nERROR: $_" -ForegroundColor Red
    exit 1
}
