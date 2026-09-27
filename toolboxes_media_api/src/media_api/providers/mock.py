"""MEDIA_BACKEND=mock: the whole service without torch, weights or a GPU.

Output is a pure function of the request (task, prompt, seed, size, inputs),
so the same request returns byte-identical files — which is what the tests and
the container smoke test rely on. It walks the same steps, progress reports
and cancellation checks as a real job, and uses the same encoders.

Only for tests and demos: `[mock:fail]` in a prompt makes the job fail.
"""

from __future__ import annotations

import hashlib
import threading
import time
from dataclasses import replace

import numpy as np
from PIL import Image, ImageDraw

from ..errors import ProviderError
from ..jobs import JobContext
from .base import Artifact, GenerationRequest, Provider
from .media import encode_video, save_image

AUDIO_RATE = 32000


def _rng(request: GenerationRequest) -> np.random.Generator:
    key = f"{request.task}|{request.seed}|{request.width}x{request.height}|{request.prompt}"
    return np.random.default_rng(int.from_bytes(hashlib.sha256(key.encode()).digest()[:8], "little"))


def _size(request: GenerationRequest) -> tuple[int, int]:
    if request.width is None or request.height is None:
        raise ValueError("the mock needs a resolved size")
    return request.width, request.height


def _canvas(request: GenerationRequest, rng: np.random.Generator) -> np.ndarray:
    w, h = _size(request)
    a, b = rng.integers(0, 256, size=3), rng.integers(0, 256, size=3)
    ramp = np.linspace(0.0, 1.0, w, dtype=np.float32)[None, :, None]
    wave = (np.sin(np.linspace(0, rng.uniform(2, 12), h, dtype=np.float32)) * 0.15)[:, None, None]
    return np.clip(a * (1 - ramp) + b * ramp + wave * 255, 0, 255).astype(np.uint8)


def _fit(path, size: tuple[int, int]) -> Image.Image:  # type: ignore[no-untyped-def]
    with Image.open(path) as image:
        return image.convert("RGB").resize(size, Image.Resampling.BILINEAR)


class MockProvider(Provider):
    # Tests may set this to hold a job at its first step until released.
    gate: threading.Event | None = None

    def load(self, ctx: JobContext) -> None:
        ctx.report("loading_model", 1.0)

    def _steps(self, request: GenerationRequest, ctx: JobContext) -> None:
        for step in range(request.steps):
            if step == 0 and self.gate is not None:
                while not self.gate.wait(0.02):
                    ctx.check_cancelled()
            ctx.check_cancelled()
            if self.settings.mock_step_seconds:
                time.sleep(self.settings.mock_step_seconds)
            ctx.report("generating", (step + 1) / request.steps)

    def generate(self, request: GenerationRequest, ctx: JobContext) -> Artifact:
        if request.width is None or request.height is None:
            # Like Qwen-Image-Edit without a size: follow the first input image.
            with Image.open(request.images[0]) as first:
                width, height = (max(16, side // 16 * 16) for side in first.size)
            request = replace(request, width=width, height=height)
        if "[mock:fail]" in request.prompt:
            raise ProviderError("mock_failure", "The mock backend was asked to fail ([mock:fail]).")
        self._steps(request, ctx)
        ctx.report("encoding", 1.0)
        rng = _rng(request)
        size = _size(request)
        if request.task == "text-to-image":
            image = Image.fromarray(_canvas(request, rng))
            ImageDraw.Draw(image).text((8, 8), f"mock {request.seed}", fill=(255, 255, 255))
            path, ctype = save_image(image, request.output_dir, request.output_format)
            return Artifact(path, ctype, *size)
        if request.task == "image-edit":
            base = _fit(request.images[0], size)
            overlay = Image.fromarray(_canvas(request, rng))
            image = Image.blend(base, overlay, 0.35)
            for extra in request.images[1:]:
                thumb = _fit(extra, (max(16, size[0] // 4), max(16, size[1] // 4)))
                image.paste(thumb, (size[0] - thumb.width, size[1] - thumb.height))
            path, ctype = save_image(image, request.output_dir, request.output_format)
            return Artifact(path, ctype, *size)
        return self._video(request, rng)

    def _video(self, request: GenerationRequest, rng: np.random.Generator) -> Artifact:
        width, height = _size(request)
        frames_n, fps = int(request.num_frames or 1), int(request.fps or 24)
        base = _canvas(request, rng).astype(np.float32)
        start = (
            np.asarray(_fit(request.start_image, (width, height)), np.float32)
            if request.start_image
            else base
        )
        end = np.asarray(_fit(request.end_image, (width, height)), np.float32) if request.end_image else base
        frames = np.empty((frames_n, height, width, 3), np.uint8)
        bar = max(4, width // 16)
        for index in range(frames_n):
            t = index / max(1, frames_n - 1)
            frame = start * (1 - t) + end * t
            x = int(t * (width - bar))
            frame[:, x : x + bar] = 255 - frame[:, x : x + bar]
            frames[index] = frame.astype(np.uint8)
        for slot, ref in enumerate(request.reference_images[:9]):
            thumb = np.asarray(_fit(ref, (width // 6, height // 6)))
            y0, x0 = 0, slot * (width // 6)
            if x0 + thumb.shape[1] <= width:
                frames[:, y0 : y0 + thumb.shape[0], x0 : x0 + thumb.shape[1]] = thumb
        audio: np.ndarray | None = None
        if request.audio:
            seconds = frames_n / fps
            clock = np.arange(int(seconds * AUDIO_RATE), dtype=np.float32) / AUDIO_RATE
            tone = float(rng.uniform(220, 880))
            audio = np.stack([np.sin(2 * np.pi * tone * clock), np.sin(2 * np.pi * tone * 1.5 * clock)]) * 0.2
        path, ctype = encode_video(frames, fps, request.output_dir, request.output_format, audio, AUDIO_RATE)
        return Artifact(path, ctype, width, height, frames_n, fps, audio is not None)
