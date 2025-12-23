#!/bin/bash
# Build Chatterbox-TTS on AGX Xavier and push to registry
# Run this ON a Xavier node (JetPack 5.1+)

set -e

REGISTRY="192.168.1.214:5000"
IMAGE_NAME="chatterbox-tts"
TAG="r35.2.1"

echo "=== Building Chatterbox-TTS for Jetson ==="
echo "Registry: $REGISTRY"
echo "Image: $IMAGE_NAME:$TAG"
echo ""

# Build the image
echo "Building Docker image..."
docker build \
    --build-arg BASE_IMAGE=nvcr.io/nvidia/l4t-pytorch:r35.2.1-pth2.0-py3 \
    -t $IMAGE_NAME:$TAG \
    -t $REGISTRY/$IMAGE_NAME:$TAG \
    .

echo ""
echo "Tagging for registry..."
docker tag $IMAGE_NAME:$TAG $REGISTRY/$IMAGE_NAME:$TAG

echo ""
echo "Pushing to registry..."
docker push $REGISTRY/$IMAGE_NAME:$TAG

echo ""
echo "=== Done! ==="
echo "Image available at: $REGISTRY/$IMAGE_NAME:$TAG"
echo ""
echo "To deploy via Fleet Commander:"
echo "  1. Select VOICE cluster"
echo "  2. Select chatterbox-tts image"
echo "  3. Deploy!"
