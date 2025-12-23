@echo off
:: Fleet Agent Deployment for Windows
:: Double-click this file or run from Command Prompt

echo.
echo =========================================
echo   Fleet Agent for Windows GPU Nodes
echo =========================================
echo.

:: Check if PowerShell is available
where powershell >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo ERROR: PowerShell not found
    pause
    exit /b 1
)

:: Run the PowerShell deployment script
powershell -ExecutionPolicy Bypass -File "%~dp0deploy-fleet-agent.ps1"

echo.
pause
