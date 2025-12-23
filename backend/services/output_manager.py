"""
Output Manager Service

Automatically syncs generated outputs to S3 and cleans up local storage.
- Monitors ComfyUI output directory
- Syncs new files to MinIO S3
- Cleans up files older than threshold
- Runs as background task
"""
import asyncio
import os
import time
from pathlib import Path
from datetime import datetime, timedelta
import boto3
from botocore.config import Config
import redis.asyncio as redis
import json

# Configuration
MINIO_ENDPOINT = os.getenv("MINIO_ENDPOINT", "http://192.168.1.214:9010")
MINIO_ACCESS_KEY = os.getenv("MINIO_ACCESS_KEY", "minioadmin")
MINIO_SECRET_KEY = os.getenv("MINIO_SECRET_KEY", "minioadmin123")
OUTPUT_BUCKET = "fleet-outputs"

# Local output paths to monitor
OUTPUT_PATHS = [
    "/workspace/ComfyUI/output",  # ComfyUI outputs
    "/data/fleet-outputs",         # S3 mount (for reference)
]

# Cleanup settings
CLEANUP_AGE_HOURS = 24  # Delete local files older than this
SYNC_INTERVAL_SECONDS = 60  # How often to sync
MIN_FREE_SPACE_GB = 5  # Trigger cleanup if free space below this


class OutputManager:
    def __init__(self, redis_url: str = "redis://comfyui-redis:6379"):
        self.redis_url = redis_url
        self.redis = None
        self.s3 = None
        self.running = False

    async def connect(self):
        """Initialize connections."""
        self.redis = redis.from_url(self.redis_url, decode_responses=True)

        # Initialize S3 client for MinIO
        self.s3 = boto3.client(
            's3',
            endpoint_url=MINIO_ENDPOINT,
            aws_access_key_id=MINIO_ACCESS_KEY,
            aws_secret_access_key=MINIO_SECRET_KEY,
            config=Config(signature_version='s3v4'),
            region_name='us-east-1'
        )

        # Ensure bucket exists
        try:
            self.s3.head_bucket(Bucket=OUTPUT_BUCKET)
        except:
            self.s3.create_bucket(Bucket=OUTPUT_BUCKET)

        print(f"[OutputManager] Connected to MinIO at {MINIO_ENDPOINT}")

    async def disconnect(self):
        """Close connections."""
        if self.redis:
            await self.redis.close()

    def stop(self):
        """Stop the manager."""
        self.running = False

    async def sync_file_to_s3(self, local_path: Path, s3_prefix: str = "") -> bool:
        """Upload a single file to S3."""
        try:
            key = f"{s3_prefix}/{local_path.name}" if s3_prefix else local_path.name
            key = key.lstrip("/")

            # Check if already exists in S3
            try:
                self.s3.head_object(Bucket=OUTPUT_BUCKET, Key=key)
                return True  # Already synced
            except:
                pass

            # Upload
            self.s3.upload_file(
                str(local_path),
                OUTPUT_BUCKET,
                key,
                ExtraArgs={'ContentType': self._get_content_type(local_path)}
            )

            # Log sync
            await self.redis.lpush("output_manager:synced", json.dumps({
                "file": local_path.name,
                "key": key,
                "size": local_path.stat().st_size,
                "synced_at": datetime.utcnow().isoformat()
            }))
            await self.redis.ltrim("output_manager:synced", 0, 999)  # Keep last 1000

            print(f"[OutputManager] Synced: {local_path.name} -> s3://{OUTPUT_BUCKET}/{key}")
            return True

        except Exception as e:
            print(f"[OutputManager] Sync failed for {local_path}: {e}")
            return False

    def _get_content_type(self, path: Path) -> str:
        """Get MIME type for file."""
        ext = path.suffix.lower()
        return {
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.webp': 'image/webp',
            '.gif': 'image/gif',
            '.mp4': 'video/mp4',
            '.webm': 'video/webm',
            '.json': 'application/json',
        }.get(ext, 'application/octet-stream')

    async def sync_outputs(self, path: str, s3_prefix: str = ""):
        """Sync all outputs from a directory to S3."""
        output_path = Path(path)
        if not output_path.exists():
            return

        synced = 0
        for item in output_path.iterdir():
            if item.is_file() and item.suffix.lower() in ['.png', '.jpg', '.jpeg', '.webp', '.mp4', '.webm', '.gif']:
                if await self.sync_file_to_s3(item, s3_prefix):
                    synced += 1

        return synced

    async def cleanup_old_files(self, path: str, max_age_hours: int = CLEANUP_AGE_HOURS):
        """Delete local files older than max_age_hours that have been synced to S3."""
        output_path = Path(path)
        if not output_path.exists():
            return 0

        cutoff = datetime.now() - timedelta(hours=max_age_hours)
        deleted = 0
        freed_bytes = 0

        for item in output_path.iterdir():
            if not item.is_file():
                continue

            # Check age
            mtime = datetime.fromtimestamp(item.stat().st_mtime)
            if mtime >= cutoff:
                continue

            # Verify exists in S3 before deleting
            key = item.name
            try:
                self.s3.head_object(Bucket=OUTPUT_BUCKET, Key=key)
            except:
                # Not in S3 yet, sync first
                if not await self.sync_file_to_s3(item):
                    continue

            # Safe to delete
            try:
                size = item.stat().st_size
                item.unlink()
                deleted += 1
                freed_bytes += size
                print(f"[OutputManager] Cleaned up: {item.name}")
            except Exception as e:
                print(f"[OutputManager] Cleanup failed for {item}: {e}")

        if deleted > 0:
            freed_mb = freed_bytes / 1024 / 1024
            print(f"[OutputManager] Cleaned {deleted} files, freed {freed_mb:.1f}MB")

            # Log cleanup
            await self.redis.lpush("output_manager:cleanup", json.dumps({
                "deleted": deleted,
                "freed_bytes": freed_bytes,
                "timestamp": datetime.utcnow().isoformat()
            }))
            await self.redis.ltrim("output_manager:cleanup", 0, 99)

        return deleted

    async def get_disk_usage(self, path: str = "/") -> dict:
        """Get disk usage stats."""
        import shutil
        total, used, free = shutil.disk_usage(path)
        return {
            "total_gb": total / 1024**3,
            "used_gb": used / 1024**3,
            "free_gb": free / 1024**3,
            "percent_used": (used / total) * 100
        }

    async def emergency_cleanup(self, path: str, target_free_gb: float = MIN_FREE_SPACE_GB):
        """Emergency cleanup when disk space is critically low."""
        output_path = Path(path)
        if not output_path.exists():
            return

        # Get all files sorted by age (oldest first)
        files = []
        for item in output_path.iterdir():
            if item.is_file() and item.suffix.lower() in ['.png', '.jpg', '.jpeg', '.webp', '.mp4', '.webm']:
                files.append((item, item.stat().st_mtime, item.stat().st_size))

        files.sort(key=lambda x: x[1])  # Sort by mtime, oldest first

        deleted = 0
        freed = 0

        for item, mtime, size in files:
            # Check if we have enough space now
            disk = await self.get_disk_usage("/")
            if disk["free_gb"] >= target_free_gb:
                break

            # Sync to S3 first
            await self.sync_file_to_s3(item)

            # Delete
            try:
                item.unlink()
                deleted += 1
                freed += size
            except:
                pass

        if deleted > 0:
            print(f"[OutputManager] Emergency cleanup: deleted {deleted} files, freed {freed/1024**2:.1f}MB")

        return deleted

    async def run(self):
        """Main loop - sync and cleanup periodically."""
        self.running = True
        print("[OutputManager] Started background sync/cleanup service")

        while self.running:
            try:
                # Check disk space
                disk = await self.get_disk_usage("/")

                # Update stats in Redis
                await self.redis.set("output_manager:stats", json.dumps({
                    "disk_free_gb": disk["free_gb"],
                    "disk_percent_used": disk["percent_used"],
                    "last_run": datetime.utcnow().isoformat()
                }))

                # Emergency cleanup if needed
                if disk["free_gb"] < MIN_FREE_SPACE_GB:
                    print(f"[OutputManager] Low disk space ({disk['free_gb']:.1f}GB), running emergency cleanup")
                    for path in OUTPUT_PATHS:
                        if Path(path).exists():
                            await self.emergency_cleanup(path)

                # Regular sync
                for path in OUTPUT_PATHS:
                    if Path(path).exists():
                        await self.sync_outputs(path)

                # Regular cleanup (files older than threshold)
                for path in OUTPUT_PATHS:
                    if Path(path).exists():
                        await self.cleanup_old_files(path)

            except Exception as e:
                print(f"[OutputManager] Error in run loop: {e}")

            # Wait before next cycle
            await asyncio.sleep(SYNC_INTERVAL_SECONDS)

        print("[OutputManager] Stopped")


# Singleton instance
output_manager: OutputManager = None


async def get_output_manager() -> OutputManager:
    """Get or create the output manager instance."""
    global output_manager
    if output_manager is None:
        output_manager = OutputManager()
        await output_manager.connect()
    return output_manager
