#!/bin/bash
# Chatterbox-Turbo TTS Setup for AGX Xavier (JetPack 5.1+)

set -e

echo "=== Chatterbox-Turbo TTS Setup ==="

# Check for JetPack
if [ -f /etc/nv_tegra_release ]; then
    echo "Detected Jetson platform"
    cat /etc/nv_tegra_release
else
    echo "Warning: Not running on Jetson. Continuing anyway..."
fi

# Check CUDA
if command -v nvcc &> /dev/null; then
    echo "CUDA version: $(nvcc --version | grep release | awk '{print $6}')"
else
    echo "Warning: CUDA not found in PATH"
fi

# Check Python version
PYTHON_VERSION=$(python3 --version 2>&1)
echo "Python: $PYTHON_VERSION"

# Create virtual environment if not exists
if [ ! -d "venv" ]; then
    echo "Creating virtual environment..."
    python3 -m venv venv --system-site-packages
fi

# Activate
source venv/bin/activate

# Upgrade pip
pip install --upgrade pip

# Install dependencies
echo "Installing dependencies..."
pip install -r requirements.txt

# Create directories
mkdir -p voices models

# Download model (optional - will auto-download on first run)
echo ""
echo "=== Setup Complete ==="
echo ""
echo "To start the TTS service:"
echo "  source venv/bin/activate"
echo "  python tts_service.py"
echo ""
echo "The model will download on first run (~1GB)"
echo ""
echo "Add voice files to ./voices/ (10-15s WAV clips work best)"
echo ""
