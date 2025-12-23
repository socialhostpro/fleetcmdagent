#!/bin/bash
# Setup Portainer to manage Docker Swarm
# Run with sudo: sudo ./setup-portainer-swarm.sh

set -e

echo "============================================="
echo "  Portainer Swarm Environment Setup"
echo "============================================="
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo "Please run with sudo: sudo $0"
    exit 1
fi

# Step 1: Enable Docker API on TCP 2375
echo "[1/4] Enabling Docker API on TCP port 2375..."

mkdir -p /etc/systemd/system/docker.service.d

cat > /etc/systemd/system/docker.service.d/override.conf << 'EOF'
[Service]
ExecStart=
ExecStart=/usr/bin/dockerd -H fd:// -H tcp://0.0.0.0:2375 --containerd=/run/containerd/containerd.sock
EOF

echo "  Created Docker override configuration"

# Step 2: Reload and restart Docker
echo "[2/4] Restarting Docker daemon..."
systemctl daemon-reload
systemctl restart docker

# Wait for Docker to be ready
sleep 5

# Verify Docker API is accessible
if curl -s http://localhost:2375/version > /dev/null 2>&1; then
    echo "  Docker API is now accessible on port 2375"
else
    echo "  WARNING: Docker API not responding on 2375"
fi

# Step 3: Restart Portainer to detect Swarm
echo "[3/4] Restarting Portainer..."
docker restart portainer 2>/dev/null || echo "  Portainer container not found"
sleep 5

# Step 4: Display status
echo "[4/4] Verifying setup..."
echo ""

echo "=== Docker Swarm Status ==="
docker node ls --format "table {{.Hostname}}\t{{.Status}}\t{{.Availability}}"
echo ""

echo "=== Docker API Test ==="
curl -s http://localhost:2375/info | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'Swarm: {d.get(\"Swarm\",{}).get(\"LocalNodeState\")}, Nodes: {d.get(\"Swarm\",{}).get(\"Nodes\")}')" 2>/dev/null || echo "API check failed"
echo ""

echo "============================================="
echo "  Setup Complete!"
echo "============================================="
echo ""
echo "Portainer Dashboard: https://192.168.1.214:9443"
echo ""
echo "The 'local' environment in Portainer should now show:"
echo "  - All 10 Swarm nodes"
echo "  - Swarm services"
echo "  - Container management for all nodes"
echo ""
echo "If you need to add a new environment manually:"
echo "  1. Go to Environments → Add environment"
echo "  2. Select 'Docker' → 'API'"
echo "  3. URL: tcp://192.168.1.214:2375"
echo "  4. Enable 'Swarm' checkbox"
echo ""
