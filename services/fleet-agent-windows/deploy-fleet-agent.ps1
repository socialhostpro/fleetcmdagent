# Fleet Agent Deployment for Windows GPU Nodes
# Run with: .\deploy-fleet-agent.ps1
#
# This agent gives Fleet Commander full control over your Windows Docker Desktop
# including GPU access, container management, and command execution.

param(
    [string]$RegistryUrl = "192.168.1.214:5000",
    [string]$FleetCommander = "http://192.168.1.214:8765",
    [string]$ModelsPath = "C:\ai-models",
    [string]$OutputsPath = "C:\ai-outputs",
    [switch]$Uninstall
)

$AgentImage = "${RegistryUrl}/fleet-agent-windows:latest"
$ContainerName = "fleet-agent"

Write-Host ""
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "  Fleet Agent for Windows GPU Nodes    " -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host ""

# Check prerequisites
function Check-Prerequisites {
    Write-Host "[1/4] Checking prerequisites..." -ForegroundColor Yellow

    # Check Docker
    try {
        $dockerVersion = docker --version
        Write-Host "  Docker: $dockerVersion" -ForegroundColor Green
    } catch {
        Write-Host "  ERROR: Docker not found. Install Docker Desktop first." -ForegroundColor Red
        exit 1
    }

    # Check if Docker is running
    try {
        docker ps | Out-Null
    } catch {
        Write-Host "  ERROR: Docker is not running. Start Docker Desktop first." -ForegroundColor Red
        exit 1
    }

    # Check NVIDIA GPU
    try {
        $gpuInfo = nvidia-smi --query-gpu=name,memory.total --format=csv,noheader
        Write-Host "  GPU: $gpuInfo" -ForegroundColor Green
    } catch {
        Write-Host "  WARNING: NVIDIA GPU not detected. Agent will run but GPU features disabled." -ForegroundColor Yellow
    }

    # Check Docker GPU support
    try {
        docker run --rm --gpus all nvidia/cuda:12.0-base nvidia-smi | Out-Null
        Write-Host "  Docker GPU: Enabled" -ForegroundColor Green
    } catch {
        Write-Host "  WARNING: Docker GPU support not enabled." -ForegroundColor Yellow
    }
}

# Configure Docker for insecure registry
function Configure-DockerRegistry {
    Write-Host "[2/4] Configuring Docker registry..." -ForegroundColor Yellow

    $dockerConfigPath = "$env:USERPROFILE\.docker\daemon.json"
    $dockerConfig = @{}

    if (Test-Path $dockerConfigPath) {
        $dockerConfig = Get-Content $dockerConfigPath | ConvertFrom-Json -AsHashtable
    }

    if (-not $dockerConfig["insecure-registries"]) {
        $dockerConfig["insecure-registries"] = @()
    }

    if ($dockerConfig["insecure-registries"] -notcontains $RegistryUrl) {
        Write-Host "  Adding $RegistryUrl to insecure registries..." -ForegroundColor Cyan
        $dockerConfig["insecure-registries"] += $RegistryUrl

        # Ensure directory exists
        $dockerConfigDir = Split-Path $dockerConfigPath
        if (-not (Test-Path $dockerConfigDir)) {
            New-Item -ItemType Directory -Path $dockerConfigDir -Force | Out-Null
        }

        $dockerConfig | ConvertTo-Json -Depth 10 | Set-Content $dockerConfigPath

        Write-Host "  NOTE: You may need to restart Docker Desktop for registry changes." -ForegroundColor Yellow
    } else {
        Write-Host "  Registry already configured" -ForegroundColor Green
    }
}

# Create directories
function Create-Directories {
    Write-Host "[3/4] Creating directories..." -ForegroundColor Yellow

    if (-not (Test-Path $ModelsPath)) {
        New-Item -ItemType Directory -Path $ModelsPath -Force | Out-Null
        Write-Host "  Created: $ModelsPath" -ForegroundColor Green
    }

    if (-not (Test-Path $OutputsPath)) {
        New-Item -ItemType Directory -Path $OutputsPath -Force | Out-Null
        Write-Host "  Created: $OutputsPath" -ForegroundColor Green
    }

    # Create subdirectories for models
    $subdirs = @("checkpoints", "loras", "embeddings", "vae", "upscale_models", "video")
    foreach ($subdir in $subdirs) {
        $path = Join-Path $ModelsPath $subdir
        if (-not (Test-Path $path)) {
            New-Item -ItemType Directory -Path $path -Force | Out-Null
        }
    }
    Write-Host "  Model directories ready" -ForegroundColor Green
}

# Deploy the agent
function Deploy-Agent {
    Write-Host "[4/4] Deploying Fleet Agent..." -ForegroundColor Yellow

    # Stop existing container
    docker stop $ContainerName 2>$null
    docker rm $ContainerName 2>$null

    # Pull latest image
    Write-Host "  Pulling image..." -ForegroundColor Cyan
    docker pull $AgentImage

    if ($LASTEXITCODE -ne 0) {
        Write-Host "  ERROR: Failed to pull image. Check registry connectivity." -ForegroundColor Red
        exit 1
    }

    # Get hostname for node ID
    $NodeId = $env:COMPUTERNAME

    # Run the agent
    Write-Host "  Starting Fleet Agent as $NodeId..." -ForegroundColor Cyan

    docker run -d `
        --name $ContainerName `
        --restart always `
        -p 9100:9100 `
        -e FLEET_COMMANDER_URL=$FleetCommander `
        -e NODE_ID=$NodeId `
        -e CLUSTER=windows `
        -e AGENT_PORT=9100 `
        -e REPORT_INTERVAL=10 `
        -v //var/run/docker.sock:/var/run/docker.sock `
        -v "${ModelsPath}:/models" `
        -v "${OutputsPath}:/outputs" `
        $AgentImage

    if ($LASTEXITCODE -eq 0) {
        Write-Host ""
        Write-Host "=========================================" -ForegroundColor Green
        Write-Host "  Fleet Agent Deployed Successfully!    " -ForegroundColor Green
        Write-Host "=========================================" -ForegroundColor Green
        Write-Host ""
        Write-Host "Node ID: $NodeId" -ForegroundColor Cyan
        Write-Host "Agent API: http://localhost:9100" -ForegroundColor Cyan
        Write-Host "Fleet Commander: $FleetCommander" -ForegroundColor Cyan
        Write-Host ""
        Write-Host "Fleet Commander can now:" -ForegroundColor Yellow
        Write-Host "  - View GPU status and metrics"
        Write-Host "  - Deploy containers (ComfyUI, WAN, SDXL, etc.)"
        Write-Host "  - Execute commands"
        Write-Host "  - Manage Docker images"
        Write-Host ""
        Write-Host "Check status: docker logs -f fleet-agent" -ForegroundColor Cyan
        Write-Host ""
    } else {
        Write-Host "  ERROR: Failed to start Fleet Agent" -ForegroundColor Red
        exit 1
    }
}

# Uninstall the agent
function Uninstall-Agent {
    Write-Host "Uninstalling Fleet Agent..." -ForegroundColor Yellow

    docker stop $ContainerName 2>$null
    docker rm $ContainerName 2>$null
    docker rmi $AgentImage 2>$null

    Write-Host "Fleet Agent removed." -ForegroundColor Green
}

# Main execution
if ($Uninstall) {
    Uninstall-Agent
} else {
    Check-Prerequisites
    Configure-DockerRegistry
    Create-Directories
    Deploy-Agent
}
