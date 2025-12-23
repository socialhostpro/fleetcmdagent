# Chatterbox-Turbo TTS for AGX Xavier (JetPack 5.1)
# Base: NVIDIA L4T PyTorch with CUDA support

ARG BASE_IMAGE=nvcr.io/nvidia/l4t-pytorch:r35.2.1-pth2.0-py3
FROM ${BASE_IMAGE}

LABEL maintainer="Fleet Commander"
LABEL description="Chatterbox-Turbo TTS Service for Jetson AGX Xavier"

# Environment
ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1
ENV VOICES_DIR=/voices
ENV MODELS_DIR=/models
ENV DEVICE=cuda
ENV PORT=8100

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    libsndfile1 \
    ffmpeg \
    libportaudio2 \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy requirements first for caching
COPY requirements.txt .

# Install Python dependencies
RUN pip3 install --no-cache-dir --upgrade pip && \
    pip3 install --no-cache-dir -r requirements.txt

# Copy service code
COPY tts_service.py .

# Create directories for voices and models
RUN mkdir -p /voices /models

# Expose port
EXPOSE 8100

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
    CMD curl -f http://localhost:8100/health || exit 1

# Run the service
CMD ["python3", "tts_service.py"]
