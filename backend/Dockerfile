FROM python:3.11-slim

WORKDIR /app

# Install nmap for network scanning and docker CLI for image management
RUN apt-get update && apt-get install -y nmap curl && \
    curl -fsSL https://get.docker.com | sh && \
    rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8765"]
