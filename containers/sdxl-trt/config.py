"""
Configuration for SDXL TensorRT Server
All paths should be S3 mounts for shared storage across cluster
"""

import os

# Model configuration
DEFAULT_MODEL = os.getenv("DEFAULT_MODEL", "stabilityai/stable-diffusion-xl-base-1.0")

# Paths (should be S3 mounts)
MODEL_PATH = os.getenv("MODEL_PATH", "/models")
OUTPUT_PATH = os.getenv("OUTPUT_PATH", "/outputs")
LORA_PATH = os.getenv("LORA_PATH", "/loras")

# Server configuration
HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", "8080"))

# Generation defaults
DEFAULT_WIDTH = 1024
DEFAULT_HEIGHT = 1024
DEFAULT_STEPS = 30
DEFAULT_GUIDANCE = 7.5
DEFAULT_SCHEDULER = "euler_a"

# Memory settings
MAX_BATCH_SIZE = 4
ENABLE_XFORMERS = True
ENABLE_TENSORRT = True

# Queue settings
MAX_QUEUE_SIZE = 100
JOB_TIMEOUT = 600  # seconds
