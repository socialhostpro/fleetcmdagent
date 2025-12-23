"""
Output Management API

Endpoints for managing generated outputs across the cluster.
"""
from fastapi import APIRouter, HTTPException, UploadFile, File
from pydantic import BaseModel
from typing import Optional, List
from pathlib import Path
import os
import json
import redis.asyncio as redis
from datetime import datetime
import boto3
from botocore.config import Config

router = APIRouter()

# Configuration
MINIO_ENDPOINT = os.getenv("MINIO_ENDPOINT", "http://192.168.1.214:9010")
MINIO_ACCESS_KEY = os.getenv("MINIO_ACCESS_KEY", "minioadmin")
MINIO_SECRET_KEY = os.getenv("MINIO_SECRET_KEY", "minioadmin123")
OUTPUT_BUCKET = "fleet-outputs"
REDIS_URL = os.getenv("REDIS_URL", "redis://comfyui-redis:6379")

# Local ComfyUI output path
COMFYUI_OUTPUT = "/workspace/ComfyUI/output"


def get_s3_client():
    """Get S3 client for MinIO."""
    return boto3.client(
        's3',
        endpoint_url=MINIO_ENDPOINT,
        aws_access_key_id=MINIO_ACCESS_KEY,
        aws_secret_access_key=MINIO_SECRET_KEY,
        config=Config(signature_version='s3v4'),
        region_name='us-east-1'
    )


@router.get("/stats")
async def get_output_stats():
    """Get output storage statistics."""
    s3 = get_s3_client()
    r = redis.from_url(REDIS_URL, decode_responses=True)

    try:
        # S3 bucket stats
        s3_objects = []
        s3_size = 0
        paginator = s3.get_paginator('list_objects_v2')
        for page in paginator.paginate(Bucket=OUTPUT_BUCKET):
            for obj in page.get('Contents', []):
                s3_objects.append(obj)
                s3_size += obj['Size']

        # Local stats
        local_count = 0
        local_size = 0
        local_path = Path(COMFYUI_OUTPUT)
        if local_path.exists():
            for item in local_path.iterdir():
                if item.is_file():
                    local_count += 1
                    local_size += item.stat().st_size

        # Get manager stats from Redis
        manager_stats = await r.get("output_manager:stats")
        manager_stats = json.loads(manager_stats) if manager_stats else {}

        return {
            "s3": {
                "bucket": OUTPUT_BUCKET,
                "objects": len(s3_objects),
                "size_mb": round(s3_size / 1024 / 1024, 2),
                "url": f"{MINIO_ENDPOINT}/{OUTPUT_BUCKET}"
            },
            "local": {
                "path": COMFYUI_OUTPUT,
                "files": local_count,
                "size_mb": round(local_size / 1024 / 1024, 2)
            },
            "manager": manager_stats
        }
    finally:
        await r.close()


@router.get("/list")
async def list_outputs(
    limit: int = 100,
    offset: int = 0,
    source: str = "s3"  # "s3" or "local"
):
    """List output files from S3 or local storage."""
    files = []

    if source == "s3":
        s3 = get_s3_client()
        try:
            response = s3.list_objects_v2(Bucket=OUTPUT_BUCKET, MaxKeys=1000)
            all_objects = response.get('Contents', [])

            # Sort by last modified (newest first)
            all_objects.sort(key=lambda x: x['LastModified'], reverse=True)

            for obj in all_objects[offset:offset + limit]:
                files.append({
                    "name": obj['Key'],
                    "size_bytes": obj['Size'],
                    "size_mb": round(obj['Size'] / 1024 / 1024, 2),
                    "modified": obj['LastModified'].isoformat(),
                    "url": f"{MINIO_ENDPOINT}/{OUTPUT_BUCKET}/{obj['Key']}",
                    "source": "s3"
                })
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))

    else:  # local
        local_path = Path(COMFYUI_OUTPUT)
        if local_path.exists():
            all_files = []
            for item in local_path.iterdir():
                if item.is_file() and item.suffix.lower() in ['.png', '.jpg', '.mp4', '.webp']:
                    stat = item.stat()
                    all_files.append({
                        "name": item.name,
                        "size_bytes": stat.st_size,
                        "size_mb": round(stat.st_size / 1024 / 1024, 2),
                        "modified": datetime.fromtimestamp(stat.st_mtime).isoformat(),
                        "source": "local"
                    })

            # Sort by modified (newest first)
            all_files.sort(key=lambda x: x['modified'], reverse=True)
            files = all_files[offset:offset + limit]

    return {
        "files": files,
        "total": len(files),
        "limit": limit,
        "offset": offset,
        "source": source
    }


@router.post("/sync")
async def sync_outputs_to_s3():
    """Manually trigger sync of local outputs to S3."""
    s3 = get_s3_client()
    local_path = Path(COMFYUI_OUTPUT)

    if not local_path.exists():
        return {"synced": 0, "message": "Local output path not found"}

    synced = 0
    errors = []

    for item in local_path.iterdir():
        if not item.is_file():
            continue
        if item.suffix.lower() not in ['.png', '.jpg', '.jpeg', '.webp', '.mp4', '.webm', '.gif']:
            continue

        try:
            # Check if exists in S3
            try:
                s3.head_object(Bucket=OUTPUT_BUCKET, Key=item.name)
                continue  # Already exists
            except:
                pass

            # Upload
            content_type = {
                '.png': 'image/png',
                '.jpg': 'image/jpeg',
                '.jpeg': 'image/jpeg',
                '.webp': 'image/webp',
                '.mp4': 'video/mp4',
                '.webm': 'video/webm',
                '.gif': 'image/gif',
            }.get(item.suffix.lower(), 'application/octet-stream')

            s3.upload_file(
                str(item),
                OUTPUT_BUCKET,
                item.name,
                ExtraArgs={'ContentType': content_type}
            )
            synced += 1

        except Exception as e:
            errors.append({"file": item.name, "error": str(e)})

    return {
        "synced": synced,
        "errors": errors,
        "message": f"Synced {synced} files to S3"
    }


@router.post("/cleanup")
async def cleanup_local_outputs(max_age_hours: int = 24, dry_run: bool = False):
    """
    Clean up local outputs older than max_age_hours.
    Only deletes files that have been synced to S3.
    """
    s3 = get_s3_client()
    local_path = Path(COMFYUI_OUTPUT)

    if not local_path.exists():
        return {"deleted": 0, "message": "Local output path not found"}

    from datetime import timedelta
    cutoff = datetime.now() - timedelta(hours=max_age_hours)

    to_delete = []
    freed_bytes = 0

    for item in local_path.iterdir():
        if not item.is_file():
            continue

        # Check age
        mtime = datetime.fromtimestamp(item.stat().st_mtime)
        if mtime >= cutoff:
            continue

        # Check if exists in S3
        try:
            s3.head_object(Bucket=OUTPUT_BUCKET, Key=item.name)
        except:
            # Not in S3, sync first
            try:
                s3.upload_file(str(item), OUTPUT_BUCKET, item.name)
            except:
                continue  # Can't sync, don't delete

        to_delete.append(item)
        freed_bytes += item.stat().st_size

    if dry_run:
        return {
            "would_delete": len(to_delete),
            "would_free_mb": round(freed_bytes / 1024 / 1024, 2),
            "files": [f.name for f in to_delete[:20]],  # First 20
            "dry_run": True
        }

    # Actually delete
    deleted = 0
    for item in to_delete:
        try:
            item.unlink()
            deleted += 1
        except:
            pass

    return {
        "deleted": deleted,
        "freed_mb": round(freed_bytes / 1024 / 1024, 2),
        "message": f"Deleted {deleted} files, freed {freed_bytes/1024/1024:.1f}MB"
    }


@router.delete("/{filename}")
async def delete_output(filename: str, source: str = "both"):
    """Delete an output file from S3 and/or local."""
    results = {}

    if source in ["s3", "both"]:
        s3 = get_s3_client()
        try:
            s3.delete_object(Bucket=OUTPUT_BUCKET, Key=filename)
            results["s3"] = "deleted"
        except Exception as e:
            results["s3"] = f"error: {e}"

    if source in ["local", "both"]:
        local_file = Path(COMFYUI_OUTPUT) / filename
        if local_file.exists():
            try:
                local_file.unlink()
                results["local"] = "deleted"
            except Exception as e:
                results["local"] = f"error: {e}"
        else:
            results["local"] = "not found"

    return {"filename": filename, "results": results}


@router.get("/{filename}")
async def get_output_url(filename: str):
    """Get URL for an output file."""
    s3 = get_s3_client()

    # Check S3
    try:
        s3.head_object(Bucket=OUTPUT_BUCKET, Key=filename)
        return {
            "filename": filename,
            "url": f"{MINIO_ENDPOINT}/{OUTPUT_BUCKET}/{filename}",
            "source": "s3"
        }
    except:
        pass

    # Check local
    local_file = Path(COMFYUI_OUTPUT) / filename
    if local_file.exists():
        return {
            "filename": filename,
            "url": f"/api/vision/outputs/{filename}",
            "source": "local"
        }

    raise HTTPException(status_code=404, detail="File not found")


@router.post("/move-all-to-s3")
async def move_all_to_s3():
    """Move all local outputs to S3 and delete local copies."""
    # First sync
    sync_result = await sync_outputs_to_s3()

    # Then cleanup with 0 hour age (all files)
    cleanup_result = await cleanup_local_outputs(max_age_hours=0, dry_run=False)

    return {
        "synced": sync_result["synced"],
        "deleted": cleanup_result["deleted"],
        "freed_mb": cleanup_result["freed_mb"],
        "message": "All outputs moved to S3"
    }
