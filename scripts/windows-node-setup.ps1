# Fleet Commander - Windows GPU Node Setup Script
# Supports RTX 3060, RTX 3090, and other NVIDIA GPUs
# Run as Administrator: Right-click > Run as Administrator

param(
    [string]$ManagerIP = "192.168.1.214",
    [string]$NodeName = $env:COMPUTERNAME,
    [string]$Cluster = "vision",
    [switch]$SkipPrereqs,
    [switch]$JoinSwarm,
    [switch]$DeployContainers
)

$ErrorActionPreference = "Stop"
$RegistryUrl = "192.168.1.214:5000"
$FleetAPI = "http://${ManagerIP}:8765/api"

Write-Host @"
===============================================
  Fleet Commander - Windows GPU Node Setup
  Manager: $ManagerIP
  Node: $NodeName
  Cluster: $Cluster
===============================================
"@ -ForegroundColor Cyan

# Check if running as Administrator
function Test-Admin {
    $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($currentUser)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Admin)) {
    Write-Host "ERROR: This script must be run as Administrator" -ForegroundColor Red
    Write-Host "Right-click the script and select 'Run as Administrator'" -ForegroundColor Yellow
    exit 1
}

# Step 1: Check Prerequisites
function Test-Prerequisites {
    Write-Host "`n[1/6] Checking prerequisites..." -ForegroundColor Yellow

    # Check Windows version (need Windows 10 1903+ or Windows 11)
    $osVersion = [System.Environment]::OSVersion.Version
    if ($osVersion.Major -lt 10) {
        throw "Windows 10 or later required"
    }
    Write-Host "  Windows version: OK" -ForegroundColor Green

    # Check for WSL2
    $wslStatus = wsl --status 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  WSL2: Not installed" -ForegroundColor Red
        Write-Host "  Installing WSL2..." -ForegroundColor Yellow
        wsl --install --no-distribution
        Write-Host "  WSL2 installed. Please RESTART your computer and run this script again." -ForegroundColor Yellow
        exit 0
    }
    Write-Host "  WSL2: OK" -ForegroundColor Green

    # Check for Docker Desktop
    $dockerPath = Get-Command docker -ErrorAction SilentlyContinue
    if (-not $dockerPath) {
        Write-Host "  Docker Desktop: Not installed" -ForegroundColor Red
        Write-Host ""
        Write-Host "  Please install Docker Desktop from:" -ForegroundColor Yellow
        Write-Host "  https://www.docker.com/products/docker-desktop/" -ForegroundColor Cyan
        Write-Host ""
        Write-Host "  After installation:" -ForegroundColor Yellow
        Write-Host "  1. Enable 'Use the WSL 2 based engine' in Settings" -ForegroundColor White
        Write-Host "  2. Enable GPU support in Settings > Resources > GPU" -ForegroundColor White
        Write-Host "  3. Restart Docker Desktop" -ForegroundColor White
        exit 1
    }

    # Check Docker is running
    $dockerInfo = docker info 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Docker Desktop is not running. Please start Docker Desktop and try again."
    }
    Write-Host "  Docker Desktop: OK" -ForegroundColor Green

    # Check NVIDIA driver
    $nvidiaSmi = nvidia-smi 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  NVIDIA Driver: Not installed" -ForegroundColor Red
        Write-Host ""
        Write-Host "  Please install NVIDIA drivers from:" -ForegroundColor Yellow
        Write-Host "  https://www.nvidia.com/Download/index.aspx" -ForegroundColor Cyan
        exit 1
    }

    # Parse GPU info
    $gpuInfo = nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>&1
    Write-Host "  NVIDIA GPU: $gpuInfo" -ForegroundColor Green

    # Check NVIDIA Container Toolkit in Docker
    $nvidiaDocker = docker run --rm --gpus all nvidia/cuda:12.0-base-ubuntu22.04 nvidia-smi 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  NVIDIA Container Toolkit: Not configured" -ForegroundColor Red
        Write-Host ""
        Write-Host "  In Docker Desktop Settings:" -ForegroundColor Yellow
        Write-Host "  1. Go to Settings > Resources > GPU" -ForegroundColor White
        Write-Host "  2. Enable 'Enable GPU access'" -ForegroundColor White
        Write-Host "  3. Restart Docker Desktop" -ForegroundColor White
        exit 1
    }
    Write-Host "  NVIDIA Container Toolkit: OK" -ForegroundColor Green

    Write-Host "`nAll prerequisites met!" -ForegroundColor Green
}

# Step 2: Configure Docker for insecure registry
function Set-DockerRegistry {
    Write-Host "`n[2/6] Configuring Docker registry..." -ForegroundColor Yellow

    $dockerConfigPath = "$env:USERPROFILE\.docker\daemon.json"
    $dockerConfig = @{
        "insecure-registries" = @($RegistryUrl)
    }

    if (Test-Path $dockerConfigPath) {
        $existingConfig = Get-Content $dockerConfigPath | ConvertFrom-Json
        if ($existingConfig."insecure-registries" -notcontains $RegistryUrl) {
            if (-not $existingConfig."insecure-registries") {
                $existingConfig | Add-Member -NotePropertyName "insecure-registries" -NotePropertyValue @($RegistryUrl)
            } else {
                $existingConfig."insecure-registries" += $RegistryUrl
            }
            $existingConfig | ConvertTo-Json -Depth 10 | Set-Content $dockerConfigPath
            Write-Host "  Added $RegistryUrl to insecure registries" -ForegroundColor Green
            Write-Host "  Please restart Docker Desktop for changes to take effect" -ForegroundColor Yellow
        } else {
            Write-Host "  Registry already configured" -ForegroundColor Green
        }
    } else {
        # Docker Desktop uses different location on Windows
        Write-Host "  Note: Configure insecure registry in Docker Desktop Settings" -ForegroundColor Yellow
        Write-Host "  Settings > Docker Engine > Add to 'insecure-registries':" -ForegroundColor White
        Write-Host "  `"insecure-registries`": [`"$RegistryUrl`"]" -ForegroundColor Cyan
    }
}

# Step 3: Get Swarm Join Token from Fleet Commander
function Get-SwarmToken {
    Write-Host "`n[3/6] Getting swarm join token..." -ForegroundColor Yellow

    try {
        $response = Invoke-RestMethod -Uri "$FleetAPI/swarm/join-token?role=worker" -Method Get
        return $response.token
    } catch {
        Write-Host "  Could not connect to Fleet Commander API at $FleetAPI" -ForegroundColor Red
        Write-Host "  Make sure Fleet Commander is running and accessible" -ForegroundColor Yellow
        throw $_
    }
}

# Step 4: Join Docker Swarm
function Join-DockerSwarm {
    param([string]$Token)

    Write-Host "`n[4/6] Joining Docker Swarm..." -ForegroundColor Yellow

    # Check if already in swarm
    $swarmInfo = docker info --format '{{.Swarm.LocalNodeState}}' 2>&1
    if ($swarmInfo -eq "active") {
        Write-Host "  Already in a swarm. Leaving first..." -ForegroundColor Yellow
        docker swarm leave --force 2>&1 | Out-Null
    }

    # Join swarm
    $joinResult = docker swarm join --token $Token "${ManagerIP}:2377" 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to join swarm: $joinResult"
    }
    Write-Host "  Successfully joined swarm!" -ForegroundColor Green

    # Get node ID
    $nodeId = docker info --format '{{.Swarm.NodeID}}' 2>&1
    Write-Host "  Node ID: $nodeId" -ForegroundColor Cyan

    return $nodeId
}

# Step 5: Register with Fleet Commander
function Register-WithFleet {
    param([string]$NodeId)

    Write-Host "`n[5/6] Registering with Fleet Commander..." -ForegroundColor Yellow

    # Get GPU info
    $gpuName = (nvidia-smi --query-gpu=name --format=csv,noheader).Trim()
    $gpuMemory = (nvidia-smi --query-gpu=memory.total --format=csv,noheader).Trim()

    $body = @{
        node_id = $NodeId
        hostname = $NodeName
        cluster = $Cluster
        labels = @{
            cluster = $Cluster
            nvidia = "true"
            gpu = $gpuName
            gpu_memory = $gpuMemory
            platform = "windows"
        }
    } | ConvertTo-Json

    try {
        # Update node labels via Fleet Commander
        $response = Invoke-RestMethod -Uri "$FleetAPI/swarm/nodes/$NodeId/labels" -Method Post -Body $body -ContentType "application/json"
        Write-Host "  Registered as $NodeName in cluster: $Cluster" -ForegroundColor Green
        Write-Host "  GPU: $gpuName ($gpuMemory)" -ForegroundColor Cyan
    } catch {
        Write-Host "  Warning: Could not register with Fleet Commander" -ForegroundColor Yellow
        Write-Host "  Node is in swarm but labels may need manual configuration" -ForegroundColor Yellow
    }
}

# Step 6: Pull and deploy containers
function Deploy-Containers {
    Write-Host "`n[6/6] Deploying GPU containers..." -ForegroundColor Yellow

    # Available containers for Windows GPU nodes
    $containers = @(
        @{
            Name = "sdxl-trt"
            Image = "${RegistryUrl}/sdxl-trt:latest"
            Description = "SDXL TensorRT - Fast image generation"
            Port = 8080
            GPURequired = $true
        },
        @{
            Name = "comfyui"
            Image = "ghcr.io/ai-dock/comfyui:latest"
            Description = "ComfyUI - Node-based image generation"
            Port = 8188
            GPURequired = $true
        },
        @{
            Name = "wan-server"
            Image = "${RegistryUrl}/wan-server:latest"
            Description = "WAN Server - Network relay"
            Port = 8000
            GPURequired = $false
        }
    )

    Write-Host "`nAvailable containers:" -ForegroundColor Cyan
    for ($i = 0; $i -lt $containers.Count; $i++) {
        $c = $containers[$i]
        $gpu = if ($c.GPURequired) { "[GPU]" } else { "" }
        Write-Host "  [$($i+1)] $($c.Name) $gpu - $($c.Description)" -ForegroundColor White
    }
    Write-Host "  [A] Deploy all" -ForegroundColor White
    Write-Host "  [S] Skip" -ForegroundColor White

    $choice = Read-Host "`nSelect containers to deploy"

    if ($choice -eq "S" -or $choice -eq "s") {
        Write-Host "Skipping container deployment" -ForegroundColor Yellow
        return
    }

    $toDeploy = @()
    if ($choice -eq "A" -or $choice -eq "a") {
        $toDeploy = $containers
    } else {
        $indices = $choice -split "," | ForEach-Object { [int]$_.Trim() - 1 }
        $toDeploy = $indices | ForEach-Object { $containers[$_] }
    }

    foreach ($container in $toDeploy) {
        Write-Host "`n  Pulling $($container.Image)..." -ForegroundColor Yellow
        docker pull $container.Image 2>&1 | Out-Null

        # Stop existing container if running
        docker stop $container.Name 2>&1 | Out-Null
        docker rm $container.Name 2>&1 | Out-Null

        $gpuFlag = if ($container.GPURequired) { "--gpus all" } else { "" }

        Write-Host "  Starting $($container.Name) on port $($container.Port)..." -ForegroundColor Yellow
        $runCmd = "docker run -d --name $($container.Name) $gpuFlag -p $($container.Port):$($container.Port) --restart unless-stopped $($container.Image)"
        Invoke-Expression $runCmd 2>&1 | Out-Null

        if ($LASTEXITCODE -eq 0) {
            Write-Host "  $($container.Name) running at http://localhost:$($container.Port)" -ForegroundColor Green
        } else {
            Write-Host "  Failed to start $($container.Name)" -ForegroundColor Red
        }
    }
}

# Step 7: Show status
function Show-Status {
    Write-Host "`n===============================================" -ForegroundColor Cyan
    Write-Host "  Setup Complete!" -ForegroundColor Green
    Write-Host "===============================================" -ForegroundColor Cyan

    Write-Host "`nNode Status:" -ForegroundColor Yellow
    $swarmStatus = docker info --format '{{.Swarm.LocalNodeState}}' 2>&1
    $nodeId = docker info --format '{{.Swarm.NodeID}}' 2>&1
    Write-Host "  Swarm Status: $swarmStatus" -ForegroundColor $(if ($swarmStatus -eq "active") { "Green" } else { "Red" })
    Write-Host "  Node ID: $nodeId" -ForegroundColor Cyan

    Write-Host "`nGPU Status:" -ForegroundColor Yellow
    nvidia-smi --query-gpu=name,memory.total,memory.free,utilization.gpu --format=csv,noheader

    Write-Host "`nRunning Containers:" -ForegroundColor Yellow
    docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

    Write-Host "`nFleet Commander Dashboard:" -ForegroundColor Yellow
    Write-Host "  http://${ManagerIP}:3456" -ForegroundColor Cyan

    Write-Host "`nNext Steps:" -ForegroundColor Yellow
    Write-Host "  1. Open Fleet Commander dashboard to verify node appears" -ForegroundColor White
    Write-Host "  2. Assign node to cluster if not already done" -ForegroundColor White
    Write-Host "  3. Deploy services via the Deploy wizard" -ForegroundColor White
}

# Main execution
try {
    if (-not $SkipPrereqs) {
        Test-Prerequisites
    }

    Set-DockerRegistry

    if ($JoinSwarm) {
        $token = Get-SwarmToken
        $nodeId = Join-DockerSwarm -Token $token
        Register-WithFleet -NodeId $nodeId
    } else {
        Write-Host "`nTo join the Docker Swarm, run with -JoinSwarm flag" -ForegroundColor Yellow
    }

    if ($DeployContainers) {
        Deploy-Containers
    } else {
        Write-Host "`nTo deploy containers, run with -DeployContainers flag" -ForegroundColor Yellow
    }

    Show-Status

} catch {
    Write-Host "`nERROR: $_" -ForegroundColor Red
    Write-Host $_.ScriptStackTrace -ForegroundColor DarkRed
    exit 1
}
