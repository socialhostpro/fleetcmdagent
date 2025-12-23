from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from contextlib import asynccontextmanager
import asyncio
import os
from api import nodes, swarm, network, ssh, vault, install, websocket, cluster, maintenance, build, director, benchmark, discovery, images, install_queue, queue, ai, llm_monitor, doctor, vision_scheduler, fleet, outputs

# Global autoscaler instance
autoscaler = None
autoscaler_task = None

# Global fleet doctor instance
fleet_doctor_instance = None
fleet_doctor_task = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage app startup and shutdown."""
    global autoscaler, autoscaler_task, fleet_doctor_instance, fleet_doctor_task

    # Startup: Initialize autoscaler if enabled
    autoscaler_enabled = os.environ.get("AUTOSCALER_ENABLED", "false").lower() == "true"
    if autoscaler_enabled:
        from services.autoscaler import AutoScaler
        redis_url = os.environ.get("REDIS_URL", "redis://comfyui-redis:6379")
        autoscaler = AutoScaler(redis_url)
        await autoscaler.connect()
        autoscaler_task = asyncio.create_task(autoscaler.run())
        print("AutoScaler started in background")

    # Startup: Initialize Fleet Doctor if enabled (default: true)
    doctor_enabled = os.environ.get("FLEET_DOCTOR_ENABLED", "true").lower() == "true"
    if doctor_enabled:
        from services.fleet_doctor import FleetDoctor, fleet_doctor
        import services.fleet_doctor as doctor_module

        redis_url = os.environ.get("REDIS_URL", "redis://comfyui-redis:6379")
        ollama_url = os.environ.get("OLLAMA_URL", "http://jessica-ollama-gb10:11434")
        model = os.environ.get("FLEET_DOCTOR_MODEL", "deepseek-coder:6.7b")

        fleet_doctor_instance = FleetDoctor(
            redis_url=redis_url,
            ollama_url=ollama_url,
            api_url="http://localhost:8765",
            model=model
        )
        await fleet_doctor_instance.connect()

        # Set the global instance for API access
        doctor_module.fleet_doctor = fleet_doctor_instance

        # Start the monitoring loop
        fleet_doctor_task = asyncio.create_task(fleet_doctor_instance.run())
        print(f"Fleet Doctor started in background (model: {model})")

    yield

    # Shutdown: Stop Fleet Doctor
    if fleet_doctor_instance:
        fleet_doctor_instance.stop()
        if fleet_doctor_task:
            fleet_doctor_task.cancel()
            try:
                await fleet_doctor_task
            except asyncio.CancelledError:
                pass
        await fleet_doctor_instance.disconnect()
        print("Fleet Doctor stopped")

    # Shutdown: Stop autoscaler
    if autoscaler:
        autoscaler.stop()
        if autoscaler_task:
            autoscaler_task.cancel()
            try:
                await autoscaler_task
            except asyncio.CancelledError:
                pass
        await autoscaler.disconnect()
        print("AutoScaler stopped")


app = FastAPI(title="Fleet Commander API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount bootstrap directory for easy curl access
# Ensure the path is correct relative to the container
app.mount("/install", StaticFiles(directory="/app/bootstrap_static"), name="install")

# REST API routes
app.include_router(nodes.router, prefix="/api/nodes", tags=["nodes"])
app.include_router(swarm.router, prefix="/api/swarm", tags=["swarm"])
app.include_router(network.router, prefix="/api/network", tags=["network"])
app.include_router(ssh.router, prefix="/api/ssh", tags=["ssh"])
app.include_router(vault.router, prefix="/api/vault", tags=["vault"])
app.include_router(install.router, prefix="/api/install", tags=["install"])
app.include_router(cluster.router, prefix="/api/clusters", tags=["clusters"])
app.include_router(maintenance.router, prefix="/api/maintenance", tags=["maintenance"])
app.include_router(build.router, prefix="/api/build", tags=["build"])
app.include_router(director.router, prefix="/api/director", tags=["director"])
app.include_router(benchmark.router, prefix="/api/benchmark", tags=["benchmark"])
app.include_router(discovery.router, prefix="/api/discovery", tags=["discovery"])
app.include_router(images.router, prefix="/api/images", tags=["images"])
app.include_router(install_queue.router, prefix="/api/install-queue", tags=["install-queue"])
app.include_router(queue.router, prefix="/api/queue", tags=["queue"])
app.include_router(ai.router, prefix="/api/ai", tags=["ai"])
app.include_router(llm_monitor.router, prefix="/api/llm-monitor", tags=["llm-monitor"])
app.include_router(doctor.router, prefix="/api/doctor", tags=["doctor"])
app.include_router(vision_scheduler.router, prefix="/api/vision", tags=["vision"])
app.include_router(fleet.router, prefix="/api/fleet", tags=["fleet"])
app.include_router(outputs.router, prefix="/api/outputs", tags=["outputs"])

# WebSocket routes (no prefix - mounted at root)
app.include_router(websocket.router, tags=["websocket"])

@app.get("/")
def read_root():
    return {"Status": "Online", "Service": "Fleet Commander API"}

@app.get("/health")
def health_check():
    return {"status": "healthy"}

@app.get("/api/status")
def api_status():
    """Status endpoint for external integrations (Jessica, etc.)"""
    return {
        "status": "online",
        "service": "Fleet Commander",
        "version": "1.0.0",
        "healthy": True
    }
