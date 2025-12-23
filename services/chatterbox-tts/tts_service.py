#!/usr/bin/env python3
"""
Chatterbox-Turbo TTS Service for AGX Xavier (JetPack 5.1+)
Minimal FastAPI service - no web UI, just API endpoints.

Model: ResembleAI/chatterbox-turbo (350M params)
Features: Voice cloning, paralinguistic tags [laugh], [cough], [chuckle]
"""

import os
import io
import time
import logging
from pathlib import Path
from typing import Optional
from contextlib import asynccontextmanager

import torch
import torchaudio as ta
from fastapi import FastAPI, HTTPException, Response, UploadFile, File, Form
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("chatterbox-tts")

# Configuration
VOICES_DIR = Path(os.getenv("VOICES_DIR", "/voices"))
MODELS_DIR = Path(os.getenv("MODELS_DIR", "/models"))
DEFAULT_VOICE = os.getenv("DEFAULT_VOICE", "default.wav")
DEVICE = os.getenv("DEVICE", "cuda" if torch.cuda.is_available() else "cpu")
MODEL_ID = os.getenv("MODEL_ID", "ResembleAI/chatterbox-turbo")

# Global model instance
model = None
sample_rate = 24000


class TTSRequest(BaseModel):
    """TTS generation request."""
    text: str = Field(..., description="Text to synthesize. Supports [laugh], [cough], [chuckle] tags.")
    voice: Optional[str] = Field(None, description="Voice file name from /voices directory")
    cfg_weight: float = Field(0.5, ge=0.0, le=1.0, description="CFG weight for generation quality")
    exaggeration: float = Field(0.5, ge=0.0, le=1.0, description="Expressiveness level")
    temperature: float = Field(0.8, ge=0.1, le=2.0, description="Sampling temperature")


class OpenAITTSRequest(BaseModel):
    """OpenAI-compatible TTS request."""
    model: str = Field("tts-1", description="Model name (ignored, uses chatterbox-turbo)")
    input: str = Field(..., description="Text to synthesize")
    voice: str = Field("default", description="Voice name")
    response_format: str = Field("wav", description="Audio format (wav only)")
    speed: float = Field(1.0, description="Speed (not implemented)")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Load model on startup."""
    global model, sample_rate

    logger.info(f"Loading Chatterbox-Turbo on {DEVICE}...")
    start = time.time()

    try:
        from chatterbox.tts import ChatterboxTTS

        # Load the turbo model
        model = ChatterboxTTS.from_pretrained(
            MODEL_ID,
            device=DEVICE,
            cache_dir=str(MODELS_DIR)
        )
        sample_rate = model.sr

        logger.info(f"Model loaded in {time.time() - start:.1f}s on {DEVICE}")
        logger.info(f"Sample rate: {sample_rate}Hz")

        # Ensure voices directory exists
        VOICES_DIR.mkdir(parents=True, exist_ok=True)

        # List available voices
        voices = list(VOICES_DIR.glob("*.wav"))
        logger.info(f"Available voices: {[v.name for v in voices]}")

    except Exception as e:
        logger.error(f"Failed to load model: {e}")
        raise

    yield

    # Cleanup
    logger.info("Shutting down TTS service")


app = FastAPI(
    title="Chatterbox-Turbo TTS",
    description="High-quality TTS with voice cloning for AGX Xavier",
    version="1.0.0",
    lifespan=lifespan
)


def get_voice_path(voice_name: Optional[str]) -> Optional[Path]:
    """Get voice file path, return None if not found."""
    if not voice_name:
        # Try default voice
        default_path = VOICES_DIR / DEFAULT_VOICE
        return default_path if default_path.exists() else None

    # Check if it's already a full path
    voice_path = Path(voice_name)
    if voice_path.exists():
        return voice_path

    # Check in voices directory
    voice_path = VOICES_DIR / voice_name
    if voice_path.exists():
        return voice_path

    # Try adding .wav extension
    voice_path = VOICES_DIR / f"{voice_name}.wav"
    if voice_path.exists():
        return voice_path

    return None


def generate_speech(
    text: str,
    voice_path: Optional[Path] = None,
    cfg_weight: float = 0.5,
    exaggeration: float = 0.5,
    temperature: float = 0.8
) -> bytes:
    """Generate speech from text."""
    if model is None:
        raise RuntimeError("Model not loaded")

    logger.info(f"Generating: '{text[:50]}...' with voice={voice_path}")
    start = time.time()

    try:
        # Generate audio
        if voice_path and voice_path.exists():
            wav = model.generate(
                text,
                audio_prompt_path=str(voice_path),
                cfg_weight=cfg_weight,
                exaggeration=exaggeration,
                temperature=temperature
            )
        else:
            # No voice reference - use default generation
            wav = model.generate(
                text,
                cfg_weight=cfg_weight,
                exaggeration=exaggeration,
                temperature=temperature
            )

        # Convert to bytes
        buffer = io.BytesIO()
        ta.save(buffer, wav, sample_rate, format="wav")
        buffer.seek(0)

        duration = wav.shape[-1] / sample_rate
        gen_time = time.time() - start
        rtf = gen_time / duration  # Real-time factor

        logger.info(f"Generated {duration:.1f}s audio in {gen_time:.1f}s (RTF: {rtf:.2f}x)")

        return buffer.getvalue()

    except Exception as e:
        logger.error(f"Generation failed: {e}")
        raise


@app.get("/health")
async def health():
    """Health check endpoint."""
    return {
        "status": "healthy" if model is not None else "loading",
        "device": DEVICE,
        "model": MODEL_ID,
        "cuda_available": torch.cuda.is_available(),
        "cuda_device": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None
    }


@app.get("/voices")
async def list_voices():
    """List available voice files."""
    voices = []
    for voice_file in VOICES_DIR.glob("*.wav"):
        # Get file info
        stat = voice_file.stat()
        voices.append({
            "name": voice_file.stem,
            "filename": voice_file.name,
            "size_bytes": stat.st_size,
            "duration_estimate": stat.st_size / (sample_rate * 2)  # Rough estimate
        })

    return {
        "voices": voices,
        "default": DEFAULT_VOICE,
        "voices_dir": str(VOICES_DIR)
    }


@app.post("/tts")
async def text_to_speech(request: TTSRequest):
    """Generate speech from text."""
    if not request.text.strip():
        raise HTTPException(400, "Text cannot be empty")

    voice_path = get_voice_path(request.voice)

    try:
        audio_bytes = generate_speech(
            text=request.text,
            voice_path=voice_path,
            cfg_weight=request.cfg_weight,
            exaggeration=request.exaggeration,
            temperature=request.temperature
        )

        return Response(
            content=audio_bytes,
            media_type="audio/wav",
            headers={
                "Content-Disposition": f'attachment; filename="tts_output.wav"',
                "X-Voice-Used": voice_path.name if voice_path else "none",
                "X-Model": MODEL_ID
            }
        )

    except Exception as e:
        logger.error(f"TTS failed: {e}")
        raise HTTPException(500, f"TTS generation failed: {str(e)}")


@app.post("/v1/audio/speech")
async def openai_tts(request: OpenAITTSRequest):
    """OpenAI-compatible TTS endpoint."""
    voice_path = get_voice_path(request.voice)

    try:
        audio_bytes = generate_speech(
            text=request.input,
            voice_path=voice_path
        )

        return Response(
            content=audio_bytes,
            media_type="audio/wav"
        )

    except Exception as e:
        raise HTTPException(500, str(e))


@app.post("/voices/upload")
async def upload_voice(
    file: UploadFile = File(...),
    name: Optional[str] = Form(None)
):
    """Upload a new voice reference file."""
    if not file.filename.endswith(('.wav', '.mp3', '.flac', '.ogg')):
        raise HTTPException(400, "Invalid file format. Use WAV, MP3, FLAC, or OGG.")

    # Determine filename
    voice_name = name or Path(file.filename).stem
    voice_path = VOICES_DIR / f"{voice_name}.wav"

    try:
        # Read uploaded file
        content = await file.read()

        # Load and resample to expected sample rate
        audio_buffer = io.BytesIO(content)
        waveform, sr = ta.load(audio_buffer)

        # Resample if needed
        if sr != sample_rate:
            resampler = ta.transforms.Resample(sr, sample_rate)
            waveform = resampler(waveform)

        # Convert to mono if stereo
        if waveform.shape[0] > 1:
            waveform = waveform.mean(dim=0, keepdim=True)

        # Save as WAV
        ta.save(str(voice_path), waveform, sample_rate)

        duration = waveform.shape[-1] / sample_rate

        return {
            "status": "uploaded",
            "name": voice_name,
            "filename": voice_path.name,
            "duration_seconds": duration,
            "sample_rate": sample_rate
        }

    except Exception as e:
        logger.error(f"Voice upload failed: {e}")
        raise HTTPException(500, f"Failed to process voice file: {str(e)}")


@app.post("/clone")
async def clone_voice(
    text: str = Form(...),
    voice_file: UploadFile = File(...),
    cfg_weight: float = Form(0.5),
    exaggeration: float = Form(0.5)
):
    """One-shot voice cloning - upload a reference and get speech."""
    try:
        # Save temp voice file
        content = await voice_file.read()
        temp_path = Path("/tmp/clone_voice.wav")

        # Process audio
        audio_buffer = io.BytesIO(content)
        waveform, sr = ta.load(audio_buffer)

        if sr != sample_rate:
            resampler = ta.transforms.Resample(sr, sample_rate)
            waveform = resampler(waveform)

        if waveform.shape[0] > 1:
            waveform = waveform.mean(dim=0, keepdim=True)

        ta.save(str(temp_path), waveform, sample_rate)

        # Generate with cloned voice
        audio_bytes = generate_speech(
            text=text,
            voice_path=temp_path,
            cfg_weight=cfg_weight,
            exaggeration=exaggeration
        )

        return Response(
            content=audio_bytes,
            media_type="audio/wav"
        )

    except Exception as e:
        raise HTTPException(500, str(e))


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", "8100"))
    host = os.getenv("HOST", "0.0.0.0")

    uvicorn.run(app, host=host, port=port)
