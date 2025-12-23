@echo off
:: Fleet Commander - Deploy GPU Containers
:: For RTX 3060, RTX 3090, and other NVIDIA GPUs

echo ===============================================
echo   Fleet Commander - GPU Container Deployment
echo ===============================================
echo.

:: Check for admin rights
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo ERROR: This script requires Administrator privileges
    echo Right-click and select "Run as administrator"
    pause
    exit /b 1
)

:: Set paths
set MODELS_PATH=C:\ai-models
set OUTPUTS_PATH=C:\ai-outputs

echo Current paths:
echo   Models: %MODELS_PATH%
echo   Outputs: %OUTPUTS_PATH%
echo.

set /p CHANGE="Change paths? (y/N): "
if /i "%CHANGE%"=="y" (
    set /p MODELS_PATH="Models path: "
    set /p OUTPUTS_PATH="Outputs path: "
)

echo.
echo Running deployment...
echo.

powershell -ExecutionPolicy Bypass -File "%~dp0windows-deploy-containers.ps1" -ModelsPath "%MODELS_PATH%" -OutputsPath "%OUTPUTS_PATH%"

echo.
pause
