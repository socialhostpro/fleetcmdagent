"""
Docker Images API - Manages images stored in S3 and loading to nodes.
Images are built/stored on Spark, AGX nodes load them on-demand.
"""
import asyncio
import os
import json
from fastapi import APIRouter, HTTPException, BackgroundTasks
from pydantic import BaseModel
from typing import List, Optional
import redis.asyncio as redis
from config import settings

router = APIRouter()
r = redis.from_url(settings.REDIS_URL, decode_responses=True)

MINIO_CONTAINER = "comfyui-minio"
BUCKET = "fleet-docker-images"


class SaveImageRequest(BaseModel):
    image: str  # Docker image name (e.g., dustynv/comfyui:r36.4.0)
    name: Optional[str] = None  # Optional output name (defaults to sanitized image name)


class LoadImageRequest(BaseModel):
    image_name: str  # Name of image tar in S3 (without .tar)
    node_ip: str  # IP of node to load image on
    credential_id: str  # Credential ID for SSH access


@router.get("/")
async def list_images():
    """List all Docker images available in S3."""
    try:
        process = await asyncio.create_subprocess_exec(
            "docker", "exec", MINIO_CONTAINER, "mc", "ls", f"myminio/{BUCKET}/", "--json",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        stdout, stderr = await process.communicate()

        images = []
        for line in stdout.decode().splitlines():
            if not line.strip():
                continue
            try:
                obj = json.loads(line)
                if obj.get('key') and obj['key'].endswith('.tar'):
                    name = obj['key'].replace('.tar', '')
                    size = obj.get('size', 0)
                    if size > 1073741824:
                        size_str = f'{size/1073741824:.1f}GB'
                    elif size > 1048576:
                        size_str = f'{size/1048576:.1f}MB'
                    else:
                        size_str = f'{size/1024:.1f}KB'
                    images.append({
                        'name': name,
                        'size': size,
                        'size_str': size_str,
                        'key': obj['key']
                    })
            except json.JSONDecodeError:
                continue

        return {"images": images, "count": len(images)}

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/save")
async def save_image(request: SaveImageRequest, background_tasks: BackgroundTasks):
    """
    Save a Docker image to S3 for fleet distribution.
    This runs in the background as it can take a while for large images.
    """
    image = request.image
    name = request.name or image.replace('/', '-').replace(':', '-')

    # Create a task ID for tracking
    task_id = f"save-image-{name}-{int(asyncio.get_event_loop().time())}"
    await r.set(f"task:{task_id}:status", "running")
    await r.set(f"task:{task_id}:logs", f"Starting to save image {image}...\n")

    async def save_task():
        try:
            logs = f"Saving Docker image {image} to S3...\n"
            await r.set(f"task:{task_id}:logs", logs)

            # Check if image exists locally
            process = await asyncio.create_subprocess_exec(
                "docker", "image", "inspect", image,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            await process.communicate()

            if process.returncode != 0:
                logs += f"Image not found locally, pulling {image}...\n"
                await r.set(f"task:{task_id}:logs", logs)

                # Pull the image
                process = await asyncio.create_subprocess_exec(
                    "docker", "pull", image,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE
                )
                stdout, stderr = await process.communicate()
                logs += stdout.decode() + stderr.decode()
                await r.set(f"task:{task_id}:logs", logs)

                if process.returncode != 0:
                    logs += f"Failed to pull image!\n"
                    await r.set(f"task:{task_id}:logs", logs)
                    await r.set(f"task:{task_id}:status", "failed")
                    return

            # Save image to tar and upload to S3
            logs += f"Exporting image to tar...\n"
            await r.set(f"task:{task_id}:logs", logs)

            tar_path = f"/tmp/{name}.tar"

            # docker save
            process = await asyncio.create_subprocess_exec(
                "docker", "save", "-o", tar_path, image,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            stdout, stderr = await process.communicate()

            if process.returncode != 0:
                logs += f"Failed to save image: {stderr.decode()}\n"
                await r.set(f"task:{task_id}:logs", logs)
                await r.set(f"task:{task_id}:status", "failed")
                return

            # Get file size
            stat = os.stat(tar_path)
            size_gb = stat.st_size / (1024**3)
            logs += f"Tar file size: {size_gb:.2f} GB\n"
            logs += f"Uploading to MinIO S3...\n"
            await r.set(f"task:{task_id}:logs", logs)

            # Copy to minio container and upload
            process = await asyncio.create_subprocess_exec(
                "docker", "cp", tar_path, f"{MINIO_CONTAINER}:/tmp/{name}.tar",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            await process.communicate()

            process = await asyncio.create_subprocess_exec(
                "docker", "exec", MINIO_CONTAINER, "mc", "cp",
                f"/tmp/{name}.tar", f"myminio/{BUCKET}/{name}.tar",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            stdout, stderr = await process.communicate()

            if process.returncode != 0:
                logs += f"Failed to upload to S3: {stderr.decode()}\n"
                await r.set(f"task:{task_id}:logs", logs)
                await r.set(f"task:{task_id}:status", "failed")
                return

            # Cleanup temp files
            os.remove(tar_path)
            process = await asyncio.create_subprocess_exec(
                "docker", "exec", MINIO_CONTAINER, "rm", f"/tmp/{name}.tar",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            await process.communicate()

            logs += f"Successfully saved {image} to s3://{BUCKET}/{name}.tar\n"
            await r.set(f"task:{task_id}:logs", logs)
            await r.set(f"task:{task_id}:status", "completed")

        except Exception as e:
            await r.set(f"task:{task_id}:logs", f"Error: {str(e)}\n")
            await r.set(f"task:{task_id}:status", "failed")

    background_tasks.add_task(save_task)
    return {"task_id": task_id, "message": f"Saving image {image} to S3"}


@router.post("/load")
async def load_image(request: LoadImageRequest, background_tasks: BackgroundTasks):
    """
    Load a Docker image from S3 onto an AGX node.
    AGX nodes don't store images - they load into memory from S3.
    """
    from api.vault import get_credential

    image_name = request.image_name
    node_ip = request.node_ip
    credential_id = request.credential_id

    # Get credential
    cred = await get_credential(credential_id)
    if not cred:
        raise HTTPException(status_code=404, detail="Credential not found")

    # Create task ID
    task_id = f"load-image-{image_name}-{node_ip.replace('.', '-')}"
    await r.set(f"task:{task_id}:status", "running")
    await r.set(f"task:{task_id}:logs", f"Loading image {image_name} on {node_ip}...\n")

    async def load_task():
        try:
            import asyncssh

            logs = f"Connecting to {node_ip} to load image {image_name}...\n"
            await r.set(f"task:{task_id}:logs", logs)

            # SSH command to load image from S3
            # First check if s3fs mount exists
            ssh_cmd = f'''
if [ -f "/mnt/s3-docker/{image_name}.tar" ]; then
    echo "Loading from s3fs mount..."
    docker load < "/mnt/s3-docker/{image_name}.tar"
else
    echo "Streaming from S3..."
    MINIO_URL="http://192.168.1.214:9010"
    curl -s -u "minioadmin:minioadmin123" "$MINIO_URL/{BUCKET}/{image_name}.tar" | docker load
fi
'''
            try:
                async with asyncssh.connect(
                    host=node_ip,
                    username=cred['username'],
                    password=cred['password'],
                    known_hosts=None,
                    connect_timeout=30
                ) as conn:
                    result = await conn.run(ssh_cmd, timeout=600)
                    output = result.stdout
                    error = result.stderr
                    exit_code = result.exit_status

                    logs += f"Output:\n{output}\n"
                    if error:
                        logs += f"Stderr:\n{error}\n"

                    if exit_code == 0:
                        logs += f"Successfully loaded {image_name} on {node_ip}\n"
                        await r.set(f"task:{task_id}:status", "completed")
                    else:
                        logs += f"Failed to load image (exit code {exit_code})\n"
                        await r.set(f"task:{task_id}:status", "failed")

            except Exception as e:
                logs += f"SSH error: {str(e)}\n"
                await r.set(f"task:{task_id}:status", "failed")
            finally:
                await r.set(f"task:{task_id}:logs", logs)

        except Exception as e:
            await r.set(f"task:{task_id}:logs", f"Error: {str(e)}\n")
            await r.set(f"task:{task_id}:status", "failed")

    background_tasks.add_task(load_task)
    return {"task_id": task_id, "message": f"Loading {image_name} on {node_ip}"}


@router.get("/task/{task_id}")
async def get_task_status(task_id: str):
    """Get the status of an image save/load task."""
    status = await r.get(f"task:{task_id}:status")
    logs = await r.get(f"task:{task_id}:logs")

    if not status:
        raise HTTPException(status_code=404, detail="Task not found")

    return {
        "task_id": task_id,
        "status": status,
        "logs": logs or ""
    }


@router.delete("/{image_name}")
async def delete_image(image_name: str):
    """Delete an image from S3."""
    try:
        process = await asyncio.create_subprocess_exec(
            "docker", "exec", MINIO_CONTAINER, "mc", "rm",
            f"myminio/{BUCKET}/{image_name}.tar",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        stdout, stderr = await process.communicate()

        if process.returncode != 0:
            raise HTTPException(status_code=500, detail=stderr.decode())

        return {"message": f"Deleted {image_name}"}

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
