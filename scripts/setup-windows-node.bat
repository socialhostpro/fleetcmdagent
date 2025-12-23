@echo off
:: Fleet Commander - Windows Node Setup
:: Run this script as Administrator

echo ===============================================
echo   Fleet Commander - Windows Node Setup
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

:: Set default manager IP
set MANAGER_IP=192.168.1.214
set /p MANAGER_IP="Fleet Commander Manager IP [%MANAGER_IP%]: "

:: Set cluster
set CLUSTER=vision
set /p CLUSTER="Cluster name [%CLUSTER%]: "

echo.
echo Running setup script...
echo.

powershell -ExecutionPolicy Bypass -File "%~dp0windows-node-setup.ps1" -ManagerIP %MANAGER_IP% -Cluster %CLUSTER% -JoinSwarm -DeployContainers

echo.
pause
