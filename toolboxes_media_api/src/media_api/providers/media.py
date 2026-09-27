"""Writing results: images through Pillow, video (+ audio) through PyAV.

Shared by the real and the mock backends, so the smoke test exercises the same
encoder a real MiniMax-H3 job uses. diffusers' own encode_video hard-codes
libx264; FFmpeg builds without it (Fedora's ffmpeg-free, LGPL builds) would
fail there, so the encoder is picked from what this FFmpeg actually has.
"""

from __future__ import annotations

import os
import tempfile
from collections.abc import Sequence
from fractions import Fraction
from pathlib import Path

import av
import numpy as np
from PIL import Image

IMAGE_FORMATS = {"png": ("PNG", "image/png"), "jpeg": ("JPEG", "image/jpeg"), "webp": ("WEBP", "image/webp")}
VIDEO_FORMATS = {"mp4": "video/mp4", "webm": "video/webm"}
_VIDEO_CODECS = {"mp4": ("libx264", "h264", "libopenh264", "mpeg4"), "webm": ("libvpx-vp9", "libvpx")}
_AUDIO_CODECS = {"mp4": ("aac",), "webm": ("libopus", "opus")}
_AAC_RATES = {96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000}


def _codec(candidates: Sequence[str]) -> str:
    for name in candidates:
        try:
            av.codec.Codec(name, "w")
        except Exception:  # noqa: S112 - probing: an unknown codec simply is not available
            continue
        return name
    raise RuntimeError(f"none of the encoders {list(candidates)} is available in this FFmpeg build")


def save_image(image: Image.Image, directory: Path, output_format: str) -> tuple[Path, str]:
    pil_format, content_type = IMAGE_FORMATS[output_format]
    path = directory / f"output.{'jpg' if output_format == 'jpeg' else output_format}"
    image = image.convert("RGB")
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".tmp-", suffix=path.suffix)
    os.close(fd)
    try:
        options = {"quality": 95} if output_format in ("jpeg", "webp") else {}
        image.save(tmp, format=pil_format, **options)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise
    return path, content_type


def as_uint8_frames(frames: np.ndarray | Sequence[Image.Image]) -> np.ndarray:
    """(F, H, W, 3) uint8 from PIL frames or float arrays in [0, 1]."""
    if not isinstance(frames, np.ndarray):
        return np.stack([np.asarray(f.convert("RGB")) for f in frames])
    if frames.dtype != np.uint8:
        return (np.clip(frames, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8)
    return frames


def encode_video(
    frames: np.ndarray,
    fps: int,
    directory: Path,
    output_format: str,
    audio: np.ndarray | None = None,
    sample_rate: int | None = None,
) -> tuple[Path, str]:
    """Write (F, H, W, 3) uint8 frames and an optional (channels, samples) float waveform."""
    if frames.ndim != 4 or frames.shape[-1] != 3:
        raise ValueError(f"expected (frames, height, width, 3), got {frames.shape}")
    height, width = frames.shape[1:3]
    path = directory / f"output.{output_format}"
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".tmp-", suffix=path.suffix)
    os.close(fd)
    try:
        with av.open(tmp, mode="w", format="mp4" if output_format == "mp4" else "webm") as container:
            vcodec = _codec(_VIDEO_CODECS[output_format])
            vstream = container.add_stream(vcodec, rate=int(fps))
            vstream.width, vstream.height, vstream.pix_fmt = width, height, "yuv420p"
            if vcodec == "libx264":
                vstream.options = {"crf": "18", "preset": "medium"}
            elif vcodec.startswith("libvpx"):
                vstream.options = {"crf": "30", "b": "0"}
            astream = None
            if audio is not None and sample_rate:
                acodec = _codec(_AUDIO_CODECS[output_format])
                # Opus is always written at 48 kHz; AAC keeps the model's own rate
                # (MiniMax-H3: 32 kHz) when it is one AAC can carry.
                rate = int(sample_rate) if acodec == "aac" and int(sample_rate) in _AAC_RATES else 48000
                astream = container.add_stream(acodec, rate=rate)
                astream.codec_context.layout = "stereo"
                astream.codec_context.time_base = Fraction(1, rate)
            for frame in frames:
                for packet in vstream.encode(av.VideoFrame.from_ndarray(frame, format="rgb24")):
                    container.mux(packet)
            for packet in vstream.encode():
                container.mux(packet)
            if astream is not None and audio is not None and sample_rate:
                _write_audio(container, astream, audio, int(sample_rate))
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise
    return path, VIDEO_FORMATS[output_format]


def _write_audio(
    container: av.container.OutputContainer, stream: av.AudioStream, audio: np.ndarray, rate: int
) -> None:
    samples = np.asarray(audio, dtype=np.float32)
    if samples.ndim == 1:
        samples = samples[None, :]
    if samples.shape[0] == 1:
        samples = np.repeat(samples, 2, axis=0)
    if samples.shape[0] != 2:
        raise ValueError(f"expected mono or stereo audio, got {samples.shape[0]} channels")
    pcm = (np.clip(samples, -1.0, 1.0) * 32767.0).astype(np.int16)
    frame = av.AudioFrame.from_ndarray(
        np.ascontiguousarray(pcm.T.reshape(1, -1)), format="s16", layout="stereo"
    )
    frame.sample_rate = rate
    cc = stream.codec_context
    resampler = av.audio.resampler.AudioResampler(
        format=cc.format or "fltp", layout="stereo", rate=cc.sample_rate
    )
    pts = 0
    for chunk in [*resampler.resample(frame), *resampler.resample(None)]:
        chunk.pts = pts
        pts += chunk.samples
        for packet in stream.encode(chunk):
            container.mux(packet)
    for packet in stream.encode(None):
        container.mux(packet)
