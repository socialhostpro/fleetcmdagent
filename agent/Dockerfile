# Fleet Agent - Lightweight GPU node monitoring agent
FROM python:3.11-slim

WORKDIR /app

# Install minimal dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    docker.io \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy agent code
COPY fleet_agent.py .

# Environment variables
ENV FLEET_API_URL=http://192.168.1.214:8765
ENV REDIS_URL=redis://192.168.1.214:6379
ENV CLUSTER=vision
ENV HEARTBEAT_INTERVAL=1.0

# Run the agent
CMD ["python", "fleet_agent.py"]
