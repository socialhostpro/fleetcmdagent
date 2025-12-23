#!/bin/bash
# Build script for minimal SDXL TensorRT container
# Run this on a Jetson node

REGISTRY="192.168.1.214:5000"
IMAGE_NAME="sdxl-trt"
TAG="1.0.0"

echo "=== Building Minimal SDXL TensorRT Container ==="
echo "Registry: $REGISTRY"
echo "Image: $IMAGE_NAME:$TAG"
echo ""

# Build the image
echo "Building image..."
docker build -t $IMAGE_NAME:$TAG .

if [ $? -ne 0 ]; then
    echo "Build failed!"
    exit 1
fi

# Tag for local registry
docker tag $IMAGE_NAME:$TAG $REGISTRY/$IMAGE_NAME:$TAG
docker tag $IMAGE_NAME:$TAG $REGISTRY/$IMAGE_NAME:latest

# Push to local registry
echo "Pushing to local registry..."
docker push $REGISTRY/$IMAGE_NAME:$TAG
docker push $REGISTRY/$IMAGE_NAME:latest

echo ""
echo "=== Build Complete ==="
echo "Image size:"
docker images $IMAGE_NAME:$TAG --format "{{.Size}}"
echo ""
echo "To deploy:"
echo "docker service create --name vision-sdxl \\"
echo "  --constraint 'node.labels.cluster==vision' \\"
echo "  --mount type=bind,source=/mnt/s3-models,target=/models \\"
echo "  --mount type=bind,source=/mnt/s3-outputs,target=/outputs \\"
echo "  --mount type=bind,source=/mnt/s3-loras,target=/loras \\"
echo "  --publish 8080:8080 \\"
echo "  $REGISTRY/$IMAGE_NAME:$TAG"
