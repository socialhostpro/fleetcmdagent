# Minimal SDXL TensorRT Container for Jetson AGX Orin
# JetPack 5.1 / L4T r35 compatible
# Size: ~8GB (base + FastAPI + Diffusers)

FROM dustynv/l4t-pytorch:r35.3.1

# Environment
ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1
ENV MODEL_PATH=/models
ENV OUTPUT_PATH=/outputs
ENV LORA_PATH=/loras
# ALL MODELS FROM SPARK VIA S3 - NEVER DOWNLOAD FROM INTERNET
# HF cache points to S3 mount - models are on SPARK
ENV HF_HOME=/models/huggingface
ENV TRANSFORMERS_CACHE=/models/huggingface
ENV DIFFUSERS_CACHE=/models/huggingface
ENV HF_HUB_OFFLINE=1
ENV TRANSFORMERS_OFFLINE=1
# CRITICAL: Disable torch dynamo/compile - incompatible with Jetson Python 3.8
ENV TORCHDYNAMO_DISABLE=1
ENV TORCH_COMPILE_DISABLE=1

# Install minimal Python packages for FastAPI inference
RUN pip3 install --no-cache-dir \
    fastapi==0.104.1 \
    uvicorn[standard]==0.24.0 \
    python-multipart==0.0.6 \
    aiofiles==23.2.1 \
    httpx==0.25.2

# Install diffusers - pinned versions for JetPack 5.x compatibility
RUN pip3 install --no-cache-dir \
    huggingface_hub==0.19.4 \
    diffusers==0.25.0 \
    transformers==4.36.0 \
    accelerate==0.25.0 \
    safetensors==0.4.1 \
    omegaconf \
    sentencepiece

# Create directories for S3 mounts
RUN mkdir -p /app /models /outputs /loras

# Copy application
COPY app.py /app/
COPY config.py /app/

WORKDIR /app

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1

CMD ["python3", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080"]
