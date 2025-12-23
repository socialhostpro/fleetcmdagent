"""
SDXL TensorRT Inference Server for Jetson Cluster
FastAPI-based API with full generation controls

Features:
- Text to image generation with all controls
- Image to image with reference images
- LoRA support from S3 mount
- Aspect ratio presets
- Model scanning and selection
- TensorRT acceleration
"""

import os
import httpx
import socket

# CRITICAL: Disable torch dynamo/compile BEFORE importing torch
# Jetson Python 3.8 has incompatible bytecode
os.environ["TORCHDYNAMO_DISABLE"] = "1"
os.environ["TORCH_COMPILE_DISABLE"] = "1"

import io
import uuid
import base64
import asyncio
from datetime import datetime
from pathlib import Path
from typing import Optional, List
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, BackgroundTasks, UploadFile, File, Form
from fastapi.responses import FileResponse, StreamingResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from PIL import Image
import torch

# Fix for older PyTorch versions missing torch.xpu and torch.mps
# Prevents errors from accelerate/diffusers checking for these backends
class MockBackend:
    """Mock backend that returns False/0/None for all operations"""
    def __getattr__(self, name):
        # Return a callable that does nothing for any attribute access
        def noop(*args, **kwargs):
            return False if name.endswith('available') else 0 if 'count' in name or 'allocated' in name or 'reserved' in name else None
        return noop

    @staticmethod
    def is_available():
        return False
    @staticmethod
    def device_count():
        return 0
    @staticmethod
    def empty_cache():
        pass
    @staticmethod
    def current_device():
        return 0
    @staticmethod
    def synchronize(*args, **kwargs):
        pass
    @staticmethod
    def memory_allocated(device=None):
        return 0
    @staticmethod
    def memory_reserved(device=None):
        return 0
    @staticmethod
    def set_device(device):
        pass
    @staticmethod
    def get_device_name(device=None):
        return ""
    @staticmethod
    def manual_seed(seed):
        pass
    @staticmethod
    def set_rng_state(state):
        pass
    @staticmethod
    def get_rng_state():
        return None

# Disable torch.compile/dynamo on Jetson (incompatible Python bytecode)
import torch._dynamo
torch._dynamo.config.suppress_errors = True
torch._dynamo.config.disable = True
# Also reset the dynamo cache to prevent any cached compilation
torch._dynamo.reset()

if not hasattr(torch, 'xpu'):
    torch.xpu = MockBackend()
if not hasattr(torch, 'mps'):
    torch.mps = MockBackend()

# Mock float8 dtypes for older PyTorch versions (added in PyTorch 2.1+)
if not hasattr(torch, 'float8_e4m3fn'):
    torch.float8_e4m3fn = torch.float16
if not hasattr(torch, 'float8_e5m2'):
    torch.float8_e5m2 = torch.float16
if not hasattr(torch, 'float8_e4m3fnuz'):
    torch.float8_e4m3fnuz = torch.float16
if not hasattr(torch, 'float8_e5m2fnuz'):
    torch.float8_e5m2fnuz = torch.float16

# Mock torch.distributed.device_mesh for older PyTorch versions
import torch.distributed
if not hasattr(torch.distributed, 'device_mesh'):
    class MockDeviceMesh:
        """Mock DeviceMesh module for older PyTorch"""
        DeviceMesh = None
        init_device_mesh = lambda *args, **kwargs: None
    torch.distributed.device_mesh = MockDeviceMesh()

# Mock torch.compiler for older PyTorch versions (added in 2.0+)
if not hasattr(torch, 'compiler'):
    class MockCompiler:
        """Mock compiler module for older PyTorch"""
        @staticmethod
        def is_compiling():
            return False
        @staticmethod
        def is_dynamo_compiling():
            return False
        @staticmethod
        def disable(*args, **kwargs):
            def decorator(fn):
                return fn
            return decorator
        @staticmethod
        def assume_constant_result(*args, **kwargs):
            def decorator(fn):
                return fn
            return decorator
    torch.compiler = MockCompiler()

# Configuration
MODEL_PATH = os.getenv("MODEL_PATH", "/models")
OUTPUT_PATH = os.getenv("OUTPUT_PATH", "/outputs")
LORA_PATH = os.getenv("LORA_PATH", "/loras")
DEFAULT_MODEL = os.getenv("DEFAULT_MODEL", "stabilityai/sd-turbo")
# S3/MinIO storage paths (models stored on central SPARK server)
S3_MODELS_PATH = os.getenv("S3_MODELS_PATH", "/data/fleet-models")
S3_LORAS_PATH = os.getenv("S3_LORAS_PATH", "/data/fleet-loras")
# Local model cache (limited storage on node - only ONE model at a time)
LOCAL_MODEL_CACHE = os.getenv("LOCAL_MODEL_CACHE", "/tmp/model-cache")
# Scheduler configuration
SCHEDULER_URL = os.getenv("SCHEDULER_URL", "http://192.168.1.214:8765/api/vision")
NODE_PORT = int(os.getenv("NODE_PORT", "8080"))
HEARTBEAT_INTERVAL = int(os.getenv("HEARTBEAT_INTERVAL", "10"))

# Global state
pipe = None
current_model = None
current_local_model_path = None  # Track what's copied locally
device = "cuda" if torch.cuda.is_available() else "cpu"
jobs = {}
loading_status = {"loading": False, "progress": 0, "stage": "", "model": None}
cancel_flags = {}  # job_id -> True to cancel
node_id = None  # Set on startup
node_hostname = socket.gethostname()
node_ip = None  # Discovered on startup
heartbeat_running = False
import shutil


def get_node_ip() -> str:
    """Get the node's IP address."""
    try:
        # Create a socket to an external server to find our IP
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("192.168.1.214", 80))  # SPARK server
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


def get_gpu_utilization() -> int:
    """Get GPU utilization percentage using tegrastats or nvidia-smi."""
    try:
        # For Jetson - parse tegrastats (runs as background process)
        import subprocess
        result = subprocess.run(
            ["tegrastats", "--interval", "100", "--samples", "1"],
            capture_output=True,
            text=True,
            timeout=2
        )
        if result.stdout:
            # Parse GR3D_FREQ from tegrastats output
            import re
            match = re.search(r'GR3D_FREQ\s+(\d+)%', result.stdout)
            if match:
                return int(match.group(1))
    except Exception:
        pass

    # Fallback - check CUDA memory usage as proxy
    if torch.cuda.is_available():
        allocated = torch.cuda.memory_allocated(0)
        total = torch.cuda.get_device_properties(0).total_memory
        if total > 0:
            return int((allocated / total) * 100)

    return 0


async def send_heartbeat():
    """Send heartbeat to scheduler."""
    global node_id, node_ip

    if not node_ip:
        node_ip = get_node_ip()

    status = "online"
    if loading_status.get("loading"):
        status = "switching"
    elif any(j.get("status") == "running" for j in jobs.values()):
        status = "busy"

    gpu_util = get_gpu_utilization()

    # Get current model name (just filename)
    model_name = None
    if current_model:
        model_name = Path(current_model).name

    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            await client.post(
                f"{SCHEDULER_URL}/nodes/heartbeat",
                json={
                    "node_id": node_id,
                    "hostname": node_hostname,
                    "ip": node_ip,
                    "port": NODE_PORT,
                    "current_model": model_name,
                    "gpu_util": gpu_util,
                    "status": status,
                }
            )
    except Exception as e:
        print(f"Heartbeat failed: {e}")


async def heartbeat_loop():
    """Background loop to send heartbeats."""
    global heartbeat_running
    heartbeat_running = True

    while heartbeat_running:
        await send_heartbeat()
        await asyncio.sleep(HEARTBEAT_INTERVAL)

# Aspect ratio presets (width, height) - SD 1.5/2.x compatible (512 base)
ASPECT_RATIOS = {
    "1:1": (512, 512),
    "16:9": (768, 432),
    "9:16": (432, 768),
    "4:3": (640, 480),
    "3:4": (480, 640),
    "3:2": (768, 512),
    "2:3": (512, 768),
    "21:9": (896, 384),
    "9:21": (384, 896),
}

# Resolution presets
RESOLUTIONS = {
    "512": 512,
    "768": 768,
    "1024": 1024,
    "1280": 1280,
    "1536": 1536,
}


class GenerationRequest(BaseModel):
    """Text to image generation request with full controls"""
    prompt: str
    negative_prompt: str = "blurry, bad quality, worst quality, low quality, normal quality, jpeg artifacts, signature, watermark, text, logo"

    # Size controls
    width: int = Field(default=1024, ge=512, le=2048)
    height: int = Field(default=1024, ge=512, le=2048)
    aspect_ratio: Optional[str] = None  # Use preset if provided

    # Generation controls
    steps: int = Field(default=30, ge=1, le=100)
    guidance_scale: float = Field(default=7.5, ge=1.0, le=20.0, alias="cfg")
    seed: Optional[int] = None
    scheduler: str = "euler_a"

    # LoRA
    lora: Optional[str] = None
    lora_scale: float = Field(default=0.8, ge=0.0, le=1.0)

    # Batch
    batch_size: int = Field(default=1, ge=1, le=4)

    # Model
    model: Optional[str] = None


class Img2ImgRequest(BaseModel):
    """Image to image with reference images"""
    prompt: str
    negative_prompt: str = "blurry, bad quality, worst quality"
    strength: float = Field(default=0.75, ge=0.0, le=1.0)
    steps: int = Field(default=30, ge=1, le=100)
    guidance_scale: float = Field(default=7.5, ge=1.0, le=20.0, alias="cfg")
    seed: Optional[int] = None
    scheduler: str = "euler_a"
    lora: Optional[str] = None
    lora_scale: float = Field(default=0.8, ge=0.0, le=1.0)


class JobStatus(BaseModel):
    """Job status response"""
    job_id: str
    status: str
    progress: int = 0
    result: Optional[str] = None
    error: Optional[str] = None
    created_at: str
    completed_at: Optional[str] = None
    image_url: Optional[str] = None


class ModelInfo(BaseModel):
    """Model information"""
    name: str
    path: str
    type: str  # "directory", "safetensors", "ckpt", "huggingface"
    size_mb: Optional[float] = None


def scan_models() -> List[ModelInfo]:
    """Scan for compatible models in the model directory"""
    models = []
    model_dir = Path(MODEL_PATH)

    if not model_dir.exists():
        return models

    for item in model_dir.iterdir():
        model_info = None

        if item.is_dir():
            # Check if it's a diffusers model directory
            if (item / "model_index.json").exists() or (item / "config.json").exists():
                model_info = ModelInfo(
                    name=item.name,
                    path=str(item),
                    type="directory",
                    size_mb=sum(f.stat().st_size for f in item.rglob("*") if f.is_file()) / (1024*1024)
                )
        elif item.suffix == ".safetensors":
            model_info = ModelInfo(
                name=item.stem,
                path=str(item),
                type="safetensors",
                size_mb=item.stat().st_size / (1024*1024)
            )
        elif item.suffix == ".ckpt":
            model_info = ModelInfo(
                name=item.stem,
                path=str(item),
                type="ckpt",
                size_mb=item.stat().st_size / (1024*1024)
            )

        if model_info:
            models.append(model_info)

    return models


def scan_s3_models() -> List[ModelInfo]:
    """Scan for available models on S3/MinIO storage (SPARK server)"""
    models = []
    s3_dir = Path(S3_MODELS_PATH)

    if not s3_dir.exists():
        print(f"S3 models path not found: {S3_MODELS_PATH}")
        return models

    # Scan for safetensors files (CivitAI models)
    for item in s3_dir.iterdir():
        if item.suffix == ".safetensors":
            models.append(ModelInfo(
                name=item.stem,
                path=str(item),
                type="safetensors",
                size_mb=item.stat().st_size / (1024*1024)
            ))
        elif item.suffix == ".ckpt":
            models.append(ModelInfo(
                name=item.stem,
                path=str(item),
                type="ckpt",
                size_mb=item.stat().st_size / (1024*1024)
            ))
        elif item.is_dir():
            # Check for diffusers model directories
            if (item / "model_index.json").exists() or (item / "config.json").exists():
                models.append(ModelInfo(
                    name=item.name,
                    path=str(item),
                    type="directory",
                    size_mb=sum(f.stat().st_size for f in item.rglob("*") if f.is_file()) / (1024*1024)
                ))
            # Check for huggingface cache structure
            elif "huggingface" in item.name.lower():
                for sub in item.rglob("*"):
                    if sub.suffix == ".safetensors" and "model" in sub.name.lower():
                        parent = sub.parent
                        if parent.name not in [m.name for m in models]:
                            models.append(ModelInfo(
                                name=parent.name,
                                path=str(parent),
                                type="huggingface_cache",
                                size_mb=sum(f.stat().st_size for f in parent.rglob("*") if f.is_file()) / (1024*1024)
                            ))

    return models


def scan_s3_loras() -> List[dict]:
    """Scan for available LoRAs on S3/MinIO storage"""
    loras = []
    s3_lora_dir = Path(S3_LORAS_PATH)

    if not s3_lora_dir.exists():
        return loras

    for item in s3_lora_dir.iterdir():
        if item.suffix in [".safetensors", ".pt"]:
            loras.append({
                "name": item.stem,
                "filename": item.name,
                "path": str(item),
                "size_mb": round(item.stat().st_size / (1024*1024), 2)
            })

    return loras


def cleanup_local_model_cache():
    """Delete any models in local cache to free storage"""
    global current_local_model_path

    cache_dir = Path(LOCAL_MODEL_CACHE)
    if cache_dir.exists():
        for item in cache_dir.iterdir():
            try:
                if item.is_file():
                    item.unlink()
                    print(f"Deleted cached model: {item.name}")
                elif item.is_dir():
                    shutil.rmtree(item)
                    print(f"Deleted cached model directory: {item.name}")
            except Exception as e:
                print(f"Failed to delete {item}: {e}")

    current_local_model_path = None


def copy_model_from_s3(model_name: str) -> str:
    """Copy a model from S3 to local cache for loading"""
    global current_local_model_path, loading_status

    s3_model_path = Path(S3_MODELS_PATH) / model_name
    if not s3_model_path.exists():
        # Try with extension
        s3_model_path = Path(S3_MODELS_PATH) / f"{model_name}.safetensors"

    if not s3_model_path.exists():
        raise ValueError(f"Model not found on S3: {model_name}")

    # Ensure local cache directory exists
    cache_dir = Path(LOCAL_MODEL_CACHE)
    cache_dir.mkdir(parents=True, exist_ok=True)

    if s3_model_path.is_file():
        # Copy single file
        local_path = cache_dir / s3_model_path.name
        loading_status["stage"] = f"Copying {s3_model_path.name} from S3"
        loading_status["progress"] = 5

        print(f"Copying model from S3: {s3_model_path} -> {local_path}")
        shutil.copy2(s3_model_path, local_path)
        current_local_model_path = str(local_path)
    else:
        # Copy directory
        local_path = cache_dir / s3_model_path.name
        loading_status["stage"] = f"Copying {s3_model_path.name} from S3"
        loading_status["progress"] = 5

        print(f"Copying model directory from S3: {s3_model_path} -> {local_path}")
        if local_path.exists():
            shutil.rmtree(local_path)
        shutil.copytree(s3_model_path, local_path)
        current_local_model_path = str(local_path)

    print(f"Model copied to local cache: {current_local_model_path}")
    return current_local_model_path


def switch_model(new_model_name: str):
    """Switch to a new model with proper cleanup flow:
    1. Unload current model from GPU
    2. Delete local model cache
    3. Copy new model from S3
    4. Load new model
    """
    global pipe, current_model, loading_status

    loading_status = {"loading": True, "progress": 0, "stage": "Starting model switch", "model": new_model_name}

    # Step 1: Unload current model from GPU
    loading_status["stage"] = "Unloading current model"
    loading_status["progress"] = 5
    if pipe is not None:
        print("Unloading current model from GPU...")
        del pipe
        pipe = None
        current_model = None
        torch.cuda.empty_cache()
        print("GPU memory cleared")

    # Step 2: Delete local model cache
    loading_status["stage"] = "Clearing local cache"
    loading_status["progress"] = 10
    print("Deleting local model cache...")
    cleanup_local_model_cache()

    # Step 3: Copy new model from S3
    loading_status["stage"] = "Copying model from S3"
    loading_status["progress"] = 15
    local_model_path = copy_model_from_s3(new_model_name)

    # Step 4: Load the new model
    loading_status["stage"] = "Loading model"
    loading_status["progress"] = 40
    load_pipeline(local_model_path)

    return current_model


def load_pipeline(model_name: str = None):
    """Load the diffusion pipeline with progress reporting"""
    global pipe, current_model, loading_status

    from diffusers import AutoPipelineForText2Image, StableDiffusionXLPipeline, EulerAncestralDiscreteScheduler

    model_to_load = model_name or DEFAULT_MODEL

    # Check for local model - supports both directories and single .safetensors files (CivitAI)
    local_model = Path(MODEL_PATH) / model_to_load.replace("/", "_")
    if local_model.exists():
        model_to_load = str(local_model)
    elif (Path(MODEL_PATH) / model_to_load).exists():
        model_to_load = str(Path(MODEL_PATH) / model_to_load)

    # Check if it's a single safetensors file (CivitAI models)
    is_single_file = model_to_load.endswith('.safetensors') or model_to_load.endswith('.ckpt')

    loading_status = {"loading": True, "progress": 0, "stage": "Starting", "model": model_to_load}
    print(f"Loading model: {model_to_load}")

    loading_status["stage"] = "Loading model weights"
    loading_status["progress"] = 10

    if is_single_file:
        # Load from single safetensors file (CivitAI models)
        print(f"Loading single file model: {model_to_load}")
        pipe = StableDiffusionXLPipeline.from_single_file(
            model_to_load,
            torch_dtype=torch.float16,
            use_safetensors=True,
        )
    else:
        # Use AutoPipeline to automatically detect the right pipeline type
        pipe = AutoPipelineForText2Image.from_pretrained(
            model_to_load,
            torch_dtype=torch.float16,
            use_safetensors=True,
        )

    loading_status["stage"] = "Configuring scheduler"
    loading_status["progress"] = 50

    pipe.scheduler = EulerAncestralDiscreteScheduler.from_config(pipe.scheduler.config)

    loading_status["stage"] = "Moving to GPU"
    loading_status["progress"] = 60

    pipe = pipe.to(device)

    loading_status["stage"] = "Enabling optimizations"
    loading_status["progress"] = 80

    if hasattr(pipe, "enable_xformers_memory_efficient_attention"):
        try:
            pipe.enable_xformers_memory_efficient_attention()
        except:
            pass

    loading_status["stage"] = "Finalizing"
    loading_status["progress"] = 90

    # Skip torch.compile on Jetson - incompatible Python bytecode
    print("Skipping torch.compile on Jetson (Python 3.8 incompatible)")

    current_model = model_to_load
    loading_status = {"loading": False, "progress": 100, "stage": "Ready", "model": current_model}
    print(f"Model loaded: {current_model}")


def apply_lora(lora_name: str, scale: float = 0.8):
    """Apply LoRA weights"""
    global pipe

    lora_path = Path(LORA_PATH) / f"{lora_name}.safetensors"
    if not lora_path.exists():
        lora_path = Path(LORA_PATH) / lora_name

    if not lora_path.exists():
        raise ValueError(f"LoRA not found: {lora_name}")

    pipe.load_lora_weights(str(lora_path))
    pipe.fuse_lora(lora_scale=scale)
    print(f"Applied LoRA: {lora_name} (scale={scale})")


def get_scheduler(name: str):
    """Get scheduler by name"""
    from diffusers import (
        EulerAncestralDiscreteScheduler,
        EulerDiscreteScheduler,
        DPMSolverMultistepScheduler,
        DDIMScheduler,
        PNDMScheduler,
        LMSDiscreteScheduler,
        HeunDiscreteScheduler,
    )

    schedulers = {
        "euler_a": EulerAncestralDiscreteScheduler,
        "euler": EulerDiscreteScheduler,
        "dpm++": DPMSolverMultistepScheduler,
        "dpm++_2m": DPMSolverMultistepScheduler,
        "ddim": DDIMScheduler,
        "pndm": PNDMScheduler,
        "lms": LMSDiscreteScheduler,
        "heun": HeunDiscreteScheduler,
    }

    scheduler_class = schedulers.get(name.lower(), EulerAncestralDiscreteScheduler)
    return scheduler_class.from_config(pipe.scheduler.config)


class CancelledError(Exception):
    """Raised when a job is cancelled"""
    pass


async def generate_image(request: GenerationRequest, job_id: str):
    """Generate image from text prompt with cancellation support"""
    global pipe

    try:
        jobs[job_id]["status"] = "running"
        cancel_flags[job_id] = False  # Initialize cancel flag

        # Load model if needed
        if request.model and request.model != current_model:
            load_pipeline(request.model)
        elif pipe is None:
            load_pipeline()

        # Check for cancellation after model load
        if cancel_flags.get(job_id, False):
            raise CancelledError("Job cancelled by user")

        # Apply aspect ratio if specified
        width, height = request.width, request.height
        if request.aspect_ratio and request.aspect_ratio in ASPECT_RATIOS:
            width, height = ASPECT_RATIOS[request.aspect_ratio]

        # Apply LoRA
        if request.lora:
            apply_lora(request.lora, request.lora_scale)

        pipe.scheduler = get_scheduler(request.scheduler)

        # Seed handling
        seed = request.seed
        if seed is None:
            seed = torch.randint(0, 2**32, (1,)).item()
        generator = torch.Generator(device=device).manual_seed(seed)

        jobs[job_id]["seed"] = seed

        def progress_callback(step, timestep, latents):
            # Check for cancellation during generation
            if cancel_flags.get(job_id, False):
                raise CancelledError("Job cancelled by user")
            jobs[job_id]["progress"] = int((step / request.steps) * 100)
            return latents

        result = pipe(
            prompt=request.prompt,
            negative_prompt=request.negative_prompt,
            width=width,
            height=height,
            num_inference_steps=request.steps,
            guidance_scale=request.guidance_scale,
            generator=generator,
            num_images_per_prompt=request.batch_size,
            callback=progress_callback,
            callback_steps=1
        )

        # Save images
        output_files = []
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")

        for i, image in enumerate(result.images):
            filename = f"{timestamp}_{job_id}_{i}.png"
            filepath = Path(OUTPUT_PATH) / filename
            image.save(filepath)
            output_files.append(filename)

        jobs[job_id]["status"] = "completed"
        jobs[job_id]["progress"] = 100
        jobs[job_id]["result"] = output_files[0] if len(output_files) == 1 else output_files
        jobs[job_id]["image_url"] = f"/output/{output_files[0]}"
        jobs[job_id]["completed_at"] = datetime.now().isoformat()

        if request.lora:
            pipe.unfuse_lora()
            pipe.unload_lora_weights()

    except CancelledError as e:
        jobs[job_id]["status"] = "cancelled"
        jobs[job_id]["error"] = str(e)
        jobs[job_id]["completed_at"] = datetime.now().isoformat()
        # Cleanup LoRA if it was applied
        if request.lora and pipe is not None:
            try:
                pipe.unfuse_lora()
                pipe.unload_lora_weights()
            except:
                pass
    except Exception as e:
        jobs[job_id]["status"] = "failed"
        jobs[job_id]["error"] = str(e)
        jobs[job_id]["completed_at"] = datetime.now().isoformat()
    finally:
        # Clean up cancel flag
        if job_id in cancel_flags:
            del cancel_flags[job_id]


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan handler - auto-loads model on startup"""
    global node_id, node_ip, heartbeat_running

    print("="*50)
    print("SDXL TensorRT Server")
    print("="*50)
    print(f"Model path: {MODEL_PATH}")
    print(f"Output path: {OUTPUT_PATH}")
    print(f"LoRA path: {LORA_PATH}")
    print(f"Device: {device}")
    print(f"CUDA available: {torch.cuda.is_available()}")
    if torch.cuda.is_available():
        print(f"GPU: {torch.cuda.get_device_name(0)}")
        print(f"Memory: {torch.cuda.get_device_properties(0).total_memory / 1024**3:.1f} GB")
    print("="*50)

    # Get node identity
    node_ip = get_node_ip()
    node_id = f"{node_hostname}-{int(datetime.now().timestamp())}"
    print(f"Node ID: {node_id}")
    print(f"Node IP: {node_ip}")
    print(f"Scheduler: {SCHEDULER_URL}")

    # Register with scheduler
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(
                f"{SCHEDULER_URL}/nodes/register",
                json={
                    "hostname": node_hostname,
                    "ip": node_ip,
                    "port": NODE_PORT,
                }
            )
            if response.status_code == 200:
                data = response.json()
                node_id = data.get("node_id", node_id)
                print(f"Registered with scheduler as: {node_id}")
    except Exception as e:
        print(f"WARNING: Failed to register with scheduler: {e}")

    # Start heartbeat loop
    heartbeat_task = asyncio.create_task(heartbeat_loop())
    print("Heartbeat started")

    # AUTO-LOAD model on startup from S3
    print(f"Auto-loading model: {DEFAULT_MODEL}")
    try:
        load_pipeline(DEFAULT_MODEL)
        print("Model ready for inference!")
    except Exception as e:
        print(f"WARNING: Failed to auto-load model: {e}")
        print("Model will be loaded on first request")

    yield

    # Shutdown
    print("Shutting down...")
    heartbeat_running = False
    heartbeat_task.cancel()
    try:
        await heartbeat_task
    except asyncio.CancelledError:
        pass
    print("Heartbeat stopped")


app = FastAPI(
    title="SDXL TensorRT Server",
    description="SDXL inference API for Jetson cluster with full generation controls",
    version="1.2.0",
    lifespan=lifespan
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    """Health check"""
    return {
        "status": "healthy",
        "device": device,
        "cuda_available": torch.cuda.is_available(),
        "model_loaded": pipe is not None,
        "current_model": current_model
    }


@app.get("/info")
async def info():
    """Server information"""
    gpu_info = {}
    if torch.cuda.is_available():
        gpu_info = {
            "name": torch.cuda.get_device_name(0),
            "memory_total": torch.cuda.get_device_properties(0).total_memory,
            "memory_allocated": torch.cuda.memory_allocated(0),
            "memory_cached": torch.cuda.memory_reserved(0)
        }

    return {
        "version": "1.2.0",
        "device": device,
        "gpu": gpu_info,
        "model": current_model,
        "paths": {
            "models": MODEL_PATH,
            "outputs": OUTPUT_PATH,
            "loras": LORA_PATH
        },
        "aspect_ratios": list(ASPECT_RATIOS.keys()),
        "resolutions": list(RESOLUTIONS.keys())
    }


@app.get("/models")
async def list_models():
    """List available models with details"""
    models = scan_models()
    return {
        "models": [m.model_dump() for m in models],
        "current": current_model,
        "default": DEFAULT_MODEL
    }


@app.get("/loras")
async def list_loras():
    """List available LoRAs"""
    loras = []
    lora_dir = Path(LORA_PATH)
    if lora_dir.exists():
        for item in lora_dir.iterdir():
            if item.suffix == ".safetensors":
                loras.append({
                    "name": item.stem,
                    "path": str(item),
                    "size_mb": item.stat().st_size / (1024*1024)
                })
    return {"loras": loras}


@app.get("/schedulers")
async def list_schedulers():
    """List available schedulers"""
    return {
        "schedulers": [
            {"id": "euler_a", "name": "Euler Ancestral", "recommended": True},
            {"id": "euler", "name": "Euler"},
            {"id": "dpm++", "name": "DPM++ 2M Karras"},
            {"id": "dpm++_2m", "name": "DPM++ 2M"},
            {"id": "ddim", "name": "DDIM"},
            {"id": "heun", "name": "Heun"},
            {"id": "lms", "name": "LMS"},
        ]
    }


@app.get("/aspect-ratios")
async def list_aspect_ratios():
    """List available aspect ratios"""
    return {
        "aspect_ratios": [
            {"id": k, "width": v[0], "height": v[1]}
            for k, v in ASPECT_RATIOS.items()
        ]
    }


@app.post("/generate", response_model=JobStatus)
async def generate(request: GenerationRequest, background_tasks: BackgroundTasks):
    """Generate image from text prompt (async)"""
    job_id = str(uuid.uuid4())[:8]

    jobs[job_id] = {
        "job_id": job_id,
        "status": "pending",
        "progress": 0,
        "result": None,
        "error": None,
        "created_at": datetime.now().isoformat(),
        "completed_at": None,
        "image_url": None,
        "request": request.model_dump()
    }

    background_tasks.add_task(generate_image, request, job_id)

    return JobStatus(**jobs[job_id])


@app.post("/generate/sync")
async def generate_sync(request: GenerationRequest):
    """Generate image synchronously - returns PNG directly"""
    global pipe

    if request.model and request.model != current_model:
        load_pipeline(request.model)
    elif pipe is None:
        load_pipeline()

    width, height = request.width, request.height
    if request.aspect_ratio and request.aspect_ratio in ASPECT_RATIOS:
        width, height = ASPECT_RATIOS[request.aspect_ratio]

    if request.lora:
        apply_lora(request.lora, request.lora_scale)

    pipe.scheduler = get_scheduler(request.scheduler)

    seed = request.seed
    if seed is None:
        seed = torch.randint(0, 2**32, (1,)).item()
    generator = torch.Generator(device=device).manual_seed(seed)

    result = pipe(
        prompt=request.prompt,
        negative_prompt=request.negative_prompt,
        width=width,
        height=height,
        num_inference_steps=request.steps,
        guidance_scale=request.guidance_scale,
        generator=generator,
        num_images_per_prompt=1
    )

    if request.lora:
        pipe.unfuse_lora()
        pipe.unload_lora_weights()

    # Save to S3 outputs
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"{timestamp}_{seed}.png"
    filepath = Path(OUTPUT_PATH) / filename
    result.images[0].save(filepath)

    # Return image
    buf = io.BytesIO()
    result.images[0].save(buf, format="PNG")
    buf.seek(0)

    return StreamingResponse(
        buf,
        media_type="image/png",
        headers={"X-Seed": str(seed), "X-Filename": filename}
    )


@app.post("/img2img")
async def img2img(
    prompt: str = Form(...),
    negative_prompt: str = Form("blurry, bad quality"),
    strength: float = Form(0.75),
    steps: int = Form(30),
    cfg: float = Form(7.5),
    seed: Optional[int] = Form(None),
    scheduler: str = Form("euler_a"),
    lora: Optional[str] = Form(None),
    lora_scale: float = Form(0.8),
    images: List[UploadFile] = File(...)
):
    """Image to image generation with reference images"""
    global pipe

    if pipe is None:
        load_pipeline()

    # Load first reference image
    img_data = await images[0].read()
    init_image = Image.open(io.BytesIO(img_data)).convert("RGB")

    # Resize to valid dimensions
    init_image = init_image.resize((1024, 1024))

    if lora:
        apply_lora(lora, lora_scale)

    pipe.scheduler = get_scheduler(scheduler)

    if seed is None:
        seed = torch.randint(0, 2**32, (1,)).item()
    generator = torch.Generator(device=device).manual_seed(seed)

    # Use img2img pipeline with AutoPipeline for compatibility
    from diffusers import AutoPipelineForImage2Image

    img2img_pipe = AutoPipelineForImage2Image.from_pipe(pipe).to(device)

    result = img2img_pipe(
        prompt=prompt,
        negative_prompt=negative_prompt,
        image=init_image,
        strength=strength,
        num_inference_steps=steps,
        guidance_scale=cfg,
        generator=generator,
    )

    if lora:
        pipe.unfuse_lora()
        pipe.unload_lora_weights()

    # Save to outputs
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"img2img_{timestamp}_{seed}.png"
    filepath = Path(OUTPUT_PATH) / filename
    result.images[0].save(filepath)

    buf = io.BytesIO()
    result.images[0].save(buf, format="PNG")
    buf.seek(0)

    return StreamingResponse(
        buf,
        media_type="image/png",
        headers={"X-Seed": str(seed), "X-Filename": filename}
    )


@app.get("/job/{job_id}", response_model=JobStatus)
async def get_job(job_id: str):
    """Get job status"""
    if job_id not in jobs:
        raise HTTPException(status_code=404, detail="Job not found")
    return JobStatus(**jobs[job_id])


@app.get("/jobs")
async def list_jobs():
    """List all jobs"""
    return {"jobs": [JobStatus(**j) for j in jobs.values()]}


@app.get("/output/{filename}")
async def get_output(filename: str):
    """Get generated image by filename"""
    filepath = Path(OUTPUT_PATH) / filename
    if not filepath.exists():
        raise HTTPException(status_code=404, detail="Image not found")
    return FileResponse(filepath, media_type="image/png")


@app.get("/outputs")
async def list_outputs(limit: int = 50):
    """List recent outputs from S3"""
    output_dir = Path(OUTPUT_PATH)
    if not output_dir.exists():
        return {"outputs": []}

    files = sorted(output_dir.glob("*.png"), key=lambda x: x.stat().st_mtime, reverse=True)
    return {
        "outputs": [
            {
                "filename": f.name,
                "url": f"/output/{f.name}",
                "size": f.stat().st_size,
                "created": datetime.fromtimestamp(f.stat().st_mtime).isoformat()
            }
            for f in files[:limit]
        ]
    }


@app.post("/load")
async def load_model(model_name: str):
    """Load a specific model"""
    try:
        load_pipeline(model_name)
        return {"status": "loaded", "model": current_model}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/unload")
async def unload_model():
    """Unload model to free memory"""
    global pipe, current_model

    if pipe is not None:
        del pipe
        pipe = None
        current_model = None
        torch.cuda.empty_cache()

    return {"status": "unloaded"}


@app.get("/loading-status")
async def get_loading_status():
    """Get model loading progress"""
    return loading_status


@app.post("/cancel/{job_id}")
async def cancel_job(job_id: str):
    """Cancel a running or pending job"""
    if job_id not in jobs:
        raise HTTPException(status_code=404, detail="Job not found")

    if jobs[job_id]["status"] in ["completed", "failed", "cancelled"]:
        return {"status": "already_finished", "job_id": job_id}

    cancel_flags[job_id] = True
    jobs[job_id]["status"] = "cancelled"
    jobs[job_id]["error"] = "Cancelled by user"
    jobs[job_id]["completed_at"] = datetime.now().isoformat()

    return {"status": "cancelled", "job_id": job_id}


@app.post("/stop-all")
async def stop_all():
    """Stop all running and pending jobs"""
    stopped = []
    for job_id, job in jobs.items():
        if job["status"] in ["pending", "running"]:
            cancel_flags[job_id] = True
            job["status"] = "cancelled"
            job["error"] = "Stopped by stop-all command"
            job["completed_at"] = datetime.now().isoformat()
            stopped.append(job_id)

    return {"status": "stopped", "jobs_cancelled": stopped}


@app.get("/queue")
async def get_queue():
    """Get current job queue status"""
    pending = [j for j in jobs.values() if j["status"] == "pending"]
    running = [j for j in jobs.values() if j["status"] == "running"]
    completed = [j for j in jobs.values() if j["status"] == "completed"]
    failed = [j for j in jobs.values() if j["status"] in ["failed", "cancelled"]]

    return {
        "queue_length": len(pending),
        "running": len(running),
        "completed": len(completed),
        "failed": len(failed),
        "pending_jobs": [{"job_id": j["job_id"], "created_at": j["created_at"]} for j in pending],
        "current_job": running[0]["job_id"] if running else None,
        "loading": loading_status
    }


# ============================================
# Gallery & Media Management Endpoints
# ============================================

@app.get("/gallery")
async def get_gallery(page: int = 1, per_page: int = 20):
    """Get paginated gallery of generated images"""
    output_dir = Path(OUTPUT_PATH)
    if not output_dir.exists():
        return {"images": [], "total": 0, "page": page, "pages": 0}

    files = sorted(output_dir.glob("*.png"), key=lambda x: x.stat().st_mtime, reverse=True)
    total = len(files)
    pages = (total + per_page - 1) // per_page
    start = (page - 1) * per_page
    end = start + per_page

    return {
        "images": [
            {
                "filename": f.name,
                "url": f"/output/{f.name}",
                "thumbnail": f"/output/{f.name}",  # Full image as thumbnail
                "size": f.stat().st_size,
                "created": datetime.fromtimestamp(f.stat().st_mtime).isoformat(),
                "width": None,  # Could extract from image if needed
                "height": None
            }
            for f in files[start:end]
        ],
        "total": total,
        "page": page,
        "pages": pages,
        "per_page": per_page
    }


@app.delete("/output/{filename}")
async def delete_output(filename: str):
    """Delete a generated image"""
    filepath = Path(OUTPUT_PATH) / filename
    if not filepath.exists():
        raise HTTPException(status_code=404, detail="Image not found")

    # Security check - ensure file is in output directory
    if not str(filepath.resolve()).startswith(str(Path(OUTPUT_PATH).resolve())):
        raise HTTPException(status_code=403, detail="Access denied")

    filepath.unlink()
    return {"status": "deleted", "filename": filename}


@app.post("/outputs/clear")
async def clear_outputs(keep_recent: int = 0):
    """Clear output folder, optionally keeping recent N images"""
    output_dir = Path(OUTPUT_PATH)
    if not output_dir.exists():
        return {"status": "empty", "deleted": 0}

    files = sorted(output_dir.glob("*.png"), key=lambda x: x.stat().st_mtime, reverse=True)
    to_delete = files[keep_recent:] if keep_recent > 0 else files

    deleted = 0
    for f in to_delete:
        try:
            f.unlink()
            deleted += 1
        except Exception:
            pass

    return {"status": "cleared", "deleted": deleted, "kept": len(files) - deleted}


# ============================================
# Model Management Endpoints
# ============================================

@app.get("/models/available")
async def list_available_models():
    """List available models (local and known HuggingFace models)"""
    local_models = scan_models()

    # Known good HuggingFace models for Jetson
    hf_models = [
        {"name": "stabilityai/sd-turbo", "type": "huggingface", "size": "~2.5GB", "description": "SD Turbo - Fast 1-4 step inference"},
        {"name": "stabilityai/sdxl-turbo", "type": "huggingface", "size": "~6GB", "description": "SDXL Turbo - Higher quality, 1-4 steps"},
        {"name": "runwayml/stable-diffusion-v1-5", "type": "huggingface", "size": "~4GB", "description": "SD 1.5 - Classic, well-tested"},
        {"name": "stabilityai/stable-diffusion-xl-base-1.0", "type": "huggingface", "size": "~6GB", "description": "SDXL Base - High quality"},
    ]

    return {
        "local": local_models,
        "huggingface": hf_models,
        "current_model": current_model,
        "model_loaded": pipe is not None
    }


@app.get("/models/s3")
async def list_s3_models():
    """List available models on S3/MinIO storage (SPARK server)

    These are the models available for selection. Due to limited node storage,
    only ONE model can be loaded at a time. When switching models, the current
    model is deleted from local cache and the new model is copied from S3.
    """
    s3_models = scan_s3_models()

    return {
        "models": [m.model_dump() for m in s3_models],
        "total": len(s3_models),
        "current_model": current_model,
        "current_local_cache": current_local_model_path,
        "s3_path": S3_MODELS_PATH,
        "note": "Only ONE model can be loaded at a time due to limited node storage"
    }


@app.get("/loras/s3")
async def list_s3_loras():
    """List available LoRAs on S3/MinIO storage (SPARK server)"""
    s3_loras = scan_s3_loras()

    return {
        "loras": s3_loras,
        "total": len(s3_loras),
        "s3_path": S3_LORAS_PATH
    }


@app.post("/models/switch")
async def switch_to_model(model_name: str, background_tasks: BackgroundTasks):
    """Switch to a different model from S3 storage

    This performs the full model switch process:
    1. Unload current model from GPU memory
    2. Delete current model from local cache (free storage)
    3. Copy new model from S3 to local cache
    4. Load new model into GPU memory

    Due to limited node storage (~28GB), only ONE model can exist locally at a time.
    """
    if loading_status.get("loading", False):
        raise HTTPException(status_code=409, detail="Model is already loading")

    # Check if model exists on S3
    s3_models = scan_s3_models()
    model_exists = any(m.name == model_name or m.name == model_name.replace(".safetensors", "") for m in s3_models)

    if not model_exists:
        available = [m.name for m in s3_models]
        raise HTTPException(
            status_code=404,
            detail=f"Model '{model_name}' not found on S3. Available: {available}"
        )

    # Perform switch in background
    def do_switch():
        try:
            switch_model(model_name)
        except Exception as e:
            loading_status["loading"] = False
            loading_status["stage"] = f"Error: {str(e)}"
            loading_status["progress"] = 0
            print(f"Model switch failed: {e}")

    background_tasks.add_task(do_switch)

    return {
        "status": "switching",
        "model": model_name,
        "message": "Model switch started. Poll /loading-status for progress."
    }


@app.get("/models/current")
async def get_current_model():
    """Get info about currently loaded model"""
    return {
        "model": current_model,
        "loaded": pipe is not None,
        "local_path": current_local_model_path,
        "gpu_memory": {
            "allocated": torch.cuda.memory_allocated(0) if torch.cuda.is_available() else 0,
            "reserved": torch.cuda.memory_reserved(0) if torch.cuda.is_available() else 0
        } if torch.cuda.is_available() else None
    }


@app.post("/models/download")
async def download_model(model_name: str, background_tasks: BackgroundTasks):
    """Download a model from HuggingFace to local storage"""
    from huggingface_hub import snapshot_download

    local_path = Path(MODEL_PATH) / model_name.replace("/", "_")

    if local_path.exists():
        return {"status": "already_exists", "path": str(local_path)}

    def do_download():
        try:
            snapshot_download(
                repo_id=model_name,
                local_dir=str(local_path),
                local_dir_use_symlinks=False
            )
        except Exception as e:
            print(f"Download failed: {e}")

    background_tasks.add_task(do_download)

    return {"status": "downloading", "model": model_name, "path": str(local_path)}


# ============================================
# LoRA Management Endpoints
# ============================================

@app.get("/loras")
async def list_loras():
    """List available LoRAs from S3 mount"""
    lora_dir = Path(LORA_PATH)
    if not lora_dir.exists():
        return {"loras": [], "total": 0}

    loras = []
    for f in lora_dir.glob("*.safetensors"):
        loras.append({
            "name": f.stem,
            "filename": f.name,
            "path": str(f),
            "size": f.stat().st_size,
            "size_mb": round(f.stat().st_size / (1024 * 1024), 2)
        })

    for f in lora_dir.glob("*.pt"):
        loras.append({
            "name": f.stem,
            "filename": f.name,
            "path": str(f),
            "size": f.stat().st_size,
            "size_mb": round(f.stat().st_size / (1024 * 1024), 2)
        })

    return {"loras": loras, "total": len(loras)}


@app.post("/loras/upload")
async def upload_lora(file: UploadFile = File(...)):
    """Upload a LoRA file to S3 mount"""
    if not file.filename.endswith(('.safetensors', '.pt')):
        raise HTTPException(status_code=400, detail="Only .safetensors and .pt files allowed")

    lora_path = Path(LORA_PATH) / file.filename

    with open(lora_path, "wb") as f:
        content = await file.read()
        f.write(content)

    return {
        "status": "uploaded",
        "filename": file.filename,
        "path": str(lora_path),
        "size": len(content)
    }


@app.delete("/loras/{filename}")
async def delete_lora(filename: str):
    """Delete a LoRA file"""
    lora_path = Path(LORA_PATH) / filename

    if not lora_path.exists():
        raise HTTPException(status_code=404, detail="LoRA not found")

    # Security check
    if not str(lora_path.resolve()).startswith(str(Path(LORA_PATH).resolve())):
        raise HTTPException(status_code=403, detail="Access denied")

    lora_path.unlink()
    return {"status": "deleted", "filename": filename}


# ============================================
# System Info Endpoints
# ============================================

@app.get("/system/gpu")
async def get_gpu_info():
    """Get GPU memory and usage info"""
    if not torch.cuda.is_available():
        return {"available": False}

    return {
        "available": True,
        "device_name": torch.cuda.get_device_name(0),
        "memory_total": torch.cuda.get_device_properties(0).total_memory,
        "memory_allocated": torch.cuda.memory_allocated(0),
        "memory_reserved": torch.cuda.memory_reserved(0),
        "memory_free": torch.cuda.get_device_properties(0).total_memory - torch.cuda.memory_reserved(0)
    }


@app.get("/system/storage")
async def get_storage_info():
    """Get storage info for model/output/lora directories"""
    import shutil

    def get_dir_info(path):
        p = Path(path)
        if not p.exists():
            return {"exists": False, "path": path}

        total, used, free = shutil.disk_usage(path)
        files = list(p.glob("*"))

        return {
            "exists": True,
            "path": path,
            "total_bytes": total,
            "used_bytes": used,
            "free_bytes": free,
            "file_count": len(files)
        }

    return {
        "models": get_dir_info(MODEL_PATH),
        "outputs": get_dir_info(OUTPUT_PATH),
        "loras": get_dir_info(LORA_PATH)
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8080)
