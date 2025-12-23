#!/bin/bash
# Output Sync & Cleanup Script
# Syncs ComfyUI outputs to S3 and cleans up old local files
# Run via cron: */15 * * * * /path/to/sync-outputs.sh

set -e

MINIO_ALIAS="local"
BUCKET="fleet-outputs"
COMFYUI_OUTPUT="/workspace/ComfyUI/output"
KEEP_HOURS=24  # Keep local files for this many hours

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

# Sync outputs to S3
sync_to_s3() {
    log "Starting sync to S3..."

    # Create temp dir
    TEMP_DIR=$(mktemp -d)

    # Copy from ComfyUI container
    docker cp comfyui:${COMFYUI_OUTPUT}/. ${TEMP_DIR}/ 2>/dev/null || true

    # Count files
    FILE_COUNT=$(find ${TEMP_DIR} -type f \( -name "*.png" -o -name "*.jpg" -o -name "*.mp4" -o -name "*.webm" -o -name "*.json" \) | wc -l)

    if [ "$FILE_COUNT" -gt 0 ]; then
        # Copy to MinIO container and sync
        docker cp ${TEMP_DIR}/. comfyui-minio:/tmp/output-sync/
        docker exec comfyui-minio mc cp --recursive /tmp/output-sync/ ${MINIO_ALIAS}/${BUCKET}/comfyui/ 2>&1 | tail -5
        docker exec comfyui-minio rm -rf /tmp/output-sync
        log "Synced ${FILE_COUNT} files to S3"
    else
        log "No files to sync"
    fi

    # Cleanup temp
    rm -rf ${TEMP_DIR}
}

# Cleanup old local files
cleanup_local() {
    log "Cleaning up files older than ${KEEP_HOURS} hours..."

    # Delete files older than KEEP_HOURS
    docker exec comfyui find ${COMFYUI_OUTPUT} -type f \
        \( -name "*.png" -o -name "*.jpg" -o -name "*.mp4" -o -name "*.webm" \) \
        -mmin +$((KEEP_HOURS * 60)) -delete 2>/dev/null || true

    # Get remaining size
    SIZE=$(docker exec comfyui du -sh ${COMFYUI_OUTPUT} 2>/dev/null | cut -f1)
    log "Local output directory size: ${SIZE}"
}

# Report stats
report_stats() {
    S3_SIZE=$(docker exec comfyui-minio mc du ${MINIO_ALIAS}/${BUCKET}/ 2>/dev/null | head -1)
    log "S3 bucket stats: ${S3_SIZE}"
}

# Main
log "=== Output Sync Started ==="
sync_to_s3
cleanup_local
report_stats
log "=== Output Sync Complete ==="
