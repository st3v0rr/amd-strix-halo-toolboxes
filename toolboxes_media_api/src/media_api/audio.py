"""Audio input for speech-to-text: decode once, on upload, to 16 kHz mono WAV.

The same rule as for images: whatever the client sent never reaches a model or
stays on disk. Only the demuxer of the declared type is opened (a file declared
as M4A never reaches FFmpeg's other demuxers), only the first audio stream is
read (a video track is never decoded), and decoding stops at the length limit,
so a small file that expands to days of audio fails early.
"""

from __future__ import annotations

import os
import tempfile
import wave
from pathlib import Path

import av
import numpy as np

from .errors import PayloadTooLarge, UnsupportedMediaType

SAMPLE_RATE = 16_000
# Declared content type -> the one FFmpeg demuxer allowed to read it. Video
# types are accepted for their sound track only (a screen recording with audio).
AUDIO_UPLOAD_TYPES = {
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/wave": "wav",
    "audio/vnd.wave": "wav",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/mp4": "mp4",
    "audio/m4a": "mp4",
    "audio/x-m4a": "mp4",
    "audio/aac": "aac",
    "audio/flac": "flac",
    "audio/x-flac": "flac",
    "audio/ogg": "ogg",
    "audio/opus": "ogg",
    "audio/webm": "webm",
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "video/webm": "webm",
}


def demuxer_for(declared_type: str | None) -> str:
    declared = (declared_type or "").split(";")[0].strip().lower()
    demuxer = AUDIO_UPLOAD_TYPES.get(declared)
    if demuxer is None:
        raise UnsupportedMediaType(
            "Upload audio as WAV, MP3, M4A/AAC, FLAC, Ogg/Opus or WebM (or a video file with sound).",
            details={"allowed": sorted(AUDIO_UPLOAD_TYPES)},
        )
    return demuxer


def decode_to_wav(source: Path, target: Path, demuxer: str, max_seconds: int) -> float:
    """Decode the first audio stream of `source` to 16 kHz mono s16 WAV at
    `target` (written atomically). Returns the duration in seconds."""
    max_samples = max_seconds * SAMPLE_RATE
    fd, tmp = tempfile.mkstemp(dir=target.parent, prefix=".tmp-", suffix=".wav")
    os.close(fd)
    written = 0
    try:
        with wave.open(tmp, "wb") as out:
            out.setnchannels(1)
            out.setsampwidth(2)
            out.setframerate(SAMPLE_RATE)
            try:
                container = av.open(str(source), mode="r", format=demuxer)
            except Exception:
                raise UnsupportedMediaType(
                    f"The file is not readable as the declared type ({demuxer})."
                ) from None
            with container:
                if not container.streams.audio:
                    raise UnsupportedMediaType("The file has no audio stream.")
                stream = container.streams.audio[0]
                resampler = av.audio.resampler.AudioResampler(format="s16", layout="mono", rate=SAMPLE_RATE)
                try:
                    for packet in container.demux(stream):
                        for frame in packet.decode():
                            for chunk in resampler.resample(frame):
                                written += _append(out, chunk, written, max_samples, max_seconds)
                    for chunk in resampler.resample(None):
                        written += _append(out, chunk, written, max_samples, max_seconds)
                except (PayloadTooLarge, UnsupportedMediaType):
                    raise
                except Exception:
                    raise UnsupportedMediaType(
                        f"The audio could not be decoded as the declared type ({demuxer})."
                    ) from None
        if written == 0:
            raise UnsupportedMediaType("The file contains no audio samples.")
        os.replace(tmp, target)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise
    return written / SAMPLE_RATE


def _append(out: wave.Wave_write, chunk: av.AudioFrame, written: int, max_samples: int, limit: int) -> int:
    pcm = chunk.to_ndarray().reshape(-1)
    if written + pcm.size > max_samples:
        raise PayloadTooLarge(f"The audio is longer than {limit} seconds.")
    out.writeframes(np.ascontiguousarray(pcm, dtype="<i2").tobytes())
    return int(pcm.size)


def read_wav(path: Path) -> np.ndarray:
    """A stored upload as float32 samples in [-1, 1] at SAMPLE_RATE."""
    with wave.open(str(path), "rb") as handle:
        if (handle.getnchannels(), handle.getsampwidth(), handle.getframerate()) != (1, 2, SAMPLE_RATE):
            raise ValueError(f"{path.name} is not 16 kHz mono 16-bit PCM")
        data = handle.readframes(handle.getnframes())
    return np.frombuffer(data, dtype="<i2").astype(np.float32) / 32768.0
