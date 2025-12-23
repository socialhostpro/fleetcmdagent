# Fleet Agent for Windows GPU Nodes
# Works on Windows Docker Desktop with NVIDIA GPU support

FROM python:3.11-slim

LABEL maintainer="Fleet Commander"
LABEL description="Fleet Agent for Windows GPU nodes"

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
RUN pip install --no-cache-dir \
    requests \
    psutil \
    minio \
    boto3

# Create app directory
WORKDIR /app

# Copy agent code
COPY agent.py /app/

# Environment variables (override at runtime)
ENV FLEET_COMMANDER_URL=http://192.168.1.214:8765
ENV NODE_ID=windows-node
ENV REPORT_INTERVAL=10
ENV CLUSTER=windows

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD python -c "import requests; requests.get('${FLEET_COMMANDER_URL}/health', timeout=5)" || exit 1

# Run agent
CMD ["python", "-u", "agent.py"]
