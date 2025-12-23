#!/usr/bin/env python3
"""
Distributed SD Worker
Connects to Redis queue, processes jobs, uploads to MinIO
"""

import os
import sys
import json
import time
import redis
import torch
import hashlib
from datetime import datetime
from io import BytesIO

# Configuration from environment
REDIS_HOST = os.environ.get('REDIS_HOST', '192.168.1.214')
REDIS_PORT = int(os.environ.get('REDIS_PORT', '6379'))
MINIO_HOST = os.environ.get('MINIO_HOST', '192.168.1.214:9010')
WORKER_ID = os.environ.get('WORKER_ID', os.environ.get('HOSTNAME', 'worker'))
MODEL_ID = os.environ.get('MODEL_ID', 'runwayml/stable-diffusion-v1-5')

# Job queue names
JOB_QUEUE = 'sd:jobs'
RESULT_QUEUE = 'sd:results'
HEARTBEAT_KEY = f'sd:worker:{WORKER_ID}:heartbeat'

print(f"=== SD Worker {WORKER_ID} starting ===")
print(f"Redis: {REDIS_HOST}:{REDIS_PORT}")
print(f"Model: {MODEL_ID}")

# Connect to Redis
try:
    r = redis.Redis(host=REDIS_HOST, port=REDIS_PORT, decode_responses=True)
    r.ping()
    print("Redis connected!")
except Exception as e:
    print(f"Redis connection failed: {e}")
    sys.exit(1)

# Load the model
print("Loading Stable Diffusion model...")
try:
    from diffusers import StableDiffusionPipeline, DPMSolverMultistepScheduler

    pipe = StableDiffusionPipeline.from_pretrained(
        MODEL_ID,
        torch_dtype=torch.float16,
        safety_checker=None,
    )
    pipe.scheduler = DPMSolverMultistepScheduler.from_config(pipe.scheduler.config)
    pipe = pipe.to("cuda")
    pipe.enable_attention_slicing()  # Memory optimization for Jetson

    print(f"Model loaded on {torch.cuda.get_device_name(0)}")
    print(f"GPU Memory: {torch.cuda.get_device_properties(0).total_memory / 1024**3:.1f} GB")

except Exception as e:
    print(f"Failed to load model: {e}")
    sys.exit(1)

def generate_image(prompt, negative_prompt="", steps=30, guidance=7.5, seed=None):
    """Generate an image from prompt"""
    generator = None
    if seed is not None:
        generator = torch.Generator(device="cuda").manual_seed(seed)

    with torch.inference_mode():
        result = pipe(
            prompt=prompt,
            negative_prompt=negative_prompt,
            num_inference_steps=steps,
            guidance_scale=guidance,
            generator=generator,
        )

    return result.images[0]

def upload_to_minio(image, job_id):
    """Upload image to MinIO"""
    try:
        import urllib.request
        import base64

        # Convert image to bytes
        buffer = BytesIO()
        image.save(buffer, format='PNG')
        image_bytes = buffer.getvalue()

        # Simple HTTP upload to MinIO
        filename = f"outputs/{job_id}.png"
        # For now, save locally - MinIO upload would need boto3/minio client
        local_path = f"/workspace/output/{job_id}.png"
        os.makedirs(os.path.dirname(local_path), exist_ok=True)
        with open(local_path, 'wb') as f:
            f.write(image_bytes)

        return local_path

    except Exception as e:
        print(f"Upload failed: {e}")
        return None

def process_job(job_data):
    """Process a single job"""
    try:
        job = json.loads(job_data)
        job_id = job.get('id', hashlib.md5(job_data.encode()).hexdigest()[:8])

        print(f"\n[Job {job_id}] Processing...")
        print(f"  Prompt: {job.get('prompt', '')[:50]}...")

        start_time = time.time()

        image = generate_image(
            prompt=job.get('prompt', 'a beautiful landscape'),
            negative_prompt=job.get('negative_prompt', ''),
            steps=job.get('steps', 30),
            guidance=job.get('guidance', 7.5),
            seed=job.get('seed'),
        )

        elapsed = time.time() - start_time
        print(f"  Generated in {elapsed:.1f}s")

        # Save/upload image
        output_path = upload_to_minio(image, job_id)

        # Report result
        result = {
            'job_id': job_id,
            'worker': WORKER_ID,
            'status': 'complete',
            'output': output_path,
            'time': elapsed,
            'timestamp': datetime.now().isoformat(),
        }
        r.lpush(RESULT_QUEUE, json.dumps(result))

        print(f"  Done! Output: {output_path}")
        return True

    except Exception as e:
        print(f"  Error: {e}")
        result = {
            'job_id': job_id if 'job_id' in dir() else 'unknown',
            'worker': WORKER_ID,
            'status': 'error',
            'error': str(e),
            'timestamp': datetime.now().isoformat(),
        }
        r.lpush(RESULT_QUEUE, json.dumps(result))
        return False

def main():
    print("\n=== Worker ready, waiting for jobs ===")
    print(f"Listening on queue: {JOB_QUEUE}")

    while True:
        try:
            # Update heartbeat
            r.setex(HEARTBEAT_KEY, 30, datetime.now().isoformat())

            # Block waiting for job (timeout 5s to allow heartbeat update)
            job = r.brpop(JOB_QUEUE, timeout=5)

            if job:
                _, job_data = job
                process_job(job_data)

        except KeyboardInterrupt:
            print("\nShutting down...")
            break
        except redis.exceptions.ConnectionError:
            print("Redis connection lost, reconnecting...")
            time.sleep(5)
        except Exception as e:
            print(f"Error: {e}")
            time.sleep(1)

    print("Worker stopped.")

if __name__ == "__main__":
    main()
