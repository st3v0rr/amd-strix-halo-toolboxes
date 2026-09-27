"""Request bodies and their validation against the selected model.

Pydantic checks shape and ranges; `normalize` then checks the request against
the model's constraints and the profile's tasks, fills defaults and resolves
the seed — all before a job exists, so an impossible request never queues.
"""

from __future__ import annotations

import math
import secrets
import unicodedata
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from .config import Limits
from .errors import ApiError, CapabilityError
from .registry import ModelSpec, ProfileSpec

MAX_SEED = 2**53 - 1  # exact in JavaScript numbers too


class _Base(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    prompt: str = Field(min_length=1, description="What to generate.")
    model: str | None = Field(default=None, description="Model id; defaults to the first model for the task.")
    profile: str | None = Field(
        default=None, description="Profile id; defaults to the model's default profile."
    )
    seed: int | None = Field(default=None, ge=0, le=MAX_SEED, description="Omit for a random seed.")
    steps: int | None = Field(default=None, ge=1, le=1000)


class ImageGenerationRequest(_Base):
    negative_prompt: str | None = None
    width: int | None = Field(default=None, ge=64, le=8192)
    height: int | None = Field(default=None, ge=64, le=8192)
    guidance: float | None = Field(default=None, ge=0.0, le=30.0)
    output_format: Literal["png", "jpeg", "webp"] = "png"


class ImageEditRequest(ImageGenerationRequest):
    image_ids: list[str] = Field(min_length=1, max_length=16, description="Upload ids, in order.")


class VideoGenerationRequest(_Base):
    width: int | None = Field(default=None, ge=64, le=8192)
    height: int | None = Field(default=None, ge=64, le=8192)
    guidance: float | None = Field(default=None, ge=0.0, le=30.0)
    negative_prompt: str | None = None
    fps: int | None = Field(default=None, ge=1, le=120)
    duration_seconds: float | None = Field(default=None, gt=0, le=120)
    num_frames: int | None = Field(default=None, ge=1, le=10_000)
    start_image_id: str | None = None
    end_image_id: str | None = None
    reference_image_ids: list[str] = Field(default_factory=list, max_length=16)
    audio: bool = True
    output_format: Literal["mp4", "webm"] = "mp4"


def _clean_text(value: str, limit: int, field: str) -> str:
    if len(value) > limit:
        raise ApiError(
            f"'{field}' is longer than {limit} characters.", details={"field": field, "max": limit}
        )
    for ch in value:
        if unicodedata.category(ch) == "Cc" and ch not in "\n\t\r":
            raise ApiError(f"'{field}' contains control characters.", details={"field": field})
    return value


def video_task(req: VideoGenerationRequest) -> str:
    if req.reference_image_ids:
        if req.start_image_id or req.end_image_id:
            raise ApiError("Use either reference images or start/end images, not both.")
        return "reference-to-video"
    if req.end_image_id:
        return "start-end-to-video"
    if req.start_image_id:
        return "image-to-video"
    return "text-to-video"


def _size(
    req: Any, model: ModelSpec, profile: ProfileSpec, limits: Limits, required: bool
) -> tuple[int | None, int | None]:
    c = model.constraints
    defaults = {**model.defaults, **profile.defaults}
    width = req.width if req.width is not None else defaults.get("width")
    height = req.height if req.height is not None else defaults.get("height")
    if (width is None) != (height is None):
        raise ApiError("Give both width and height, or neither.")
    if width is None or height is None:
        if required:
            raise ApiError("width and height are required for this model.")
        return None, None
    multiple = int(c.get("size_multiple", 8))
    lo, hi = (
        int(c.get("min_side", 64)),
        min(int(c.get("max_side", 8192)), limits.max_width, limits.max_height),
    )
    problems = []
    for name, value, limit in (("width", width, limits.max_width), ("height", height, limits.max_height)):
        if value % multiple:
            problems.append(f"{name} must be a multiple of {multiple}")
        if not lo <= value <= min(hi, limit):
            problems.append(f"{name} must be between {lo} and {min(hi, limit)}")
    max_pixels = min(int(c.get("max_pixels", limits.max_pixels)), limits.max_pixels)
    if width * height > max_pixels:
        problems.append(f"width x height must not exceed {max_pixels} pixels")
    aspect = width / height
    if not c.get("min_aspect", 0) <= aspect <= c.get("max_aspect", math.inf):
        problems.append(f"aspect ratio must be between {c.get('min_aspect')} and {c.get('max_aspect')}")
    if problems:
        raise CapabilityError(
            f"Size {width}x{height} is not valid for '{model.id}': " + "; ".join(problems) + ".",
            details={"model": model.id, "width": width, "height": height},
        )
    return width, height


def _frames(req: VideoGenerationRequest, model: ModelSpec, fps: int, limits: Limits) -> int:
    c = model.constraints
    if req.num_frames is not None and req.duration_seconds is not None:
        raise ApiError("Give duration_seconds or num_frames, not both.")
    if req.num_frames is not None:
        frames = req.num_frames
    else:
        seconds = req.duration_seconds or model.defaults.get("duration_seconds", 5)
        frames = max(1, round(seconds * fps))
    grid = c.get("frame_grid")
    if grid:  # snap up to the model's own grid, e.g. 17 * n + 5 for MiniMax-H3
        period, offset = int(grid[0]), int(grid[1])
        frames = max(frames, offset)
        frames += (offset - frames) % period
    lo, hi = int(c.get("min_frames", 1)), min(int(c.get("max_frames", limits.max_frames)), limits.max_frames)
    if not lo <= frames <= hi:
        raise CapabilityError(
            f"'{model.id}' generates {lo}-{hi} frames ({lo / fps:.2f}-{hi / fps:.2f} s at {fps} fps); "
            f"this request resolves to {frames}.",
            details={"model": model.id, "num_frames": frames, "min": lo, "max": hi},
        )
    return frames


def normalize(
    req: ImageGenerationRequest | ImageEditRequest | VideoGenerationRequest,
    task: str,
    model: ModelSpec,
    profile: ProfileSpec,
    limits: Limits,
) -> dict[str, Any]:
    """The job's parameters: validated, defaults applied, seed resolved."""
    c = model.constraints
    defaults = {**model.defaults, **profile.defaults}
    params: dict[str, Any] = {"prompt": _clean_text(req.prompt, limits.max_prompt_chars, "prompt")}
    unsupported = []
    if req.guidance is not None and not c.get("guidance", False):
        unsupported.append("guidance (the model is guidance-distilled)")
    if req.negative_prompt and not c.get("negative_prompt", False):
        unsupported.append("negative_prompt")
    if unsupported:
        raise CapabilityError(
            f"'{model.id}' does not take: " + ", ".join(unsupported) + ".",
            details={"model": model.id, "unsupported": unsupported},
        )
    if c.get("negative_prompt"):
        negative = req.negative_prompt if req.negative_prompt is not None else defaults.get("negative_prompt")
        params["negative_prompt"] = _clean_text(
            negative or "", limits.max_negative_prompt_chars, "negative_prompt"
        )
    if c.get("guidance"):
        params["guidance"] = float(
            req.guidance if req.guidance is not None else defaults.get("guidance", 1.0)
        )
    steps = req.steps if req.steps is not None else int(defaults.get("steps", 20))
    if steps > limits.max_steps:
        raise ApiError(f"steps must not exceed {limits.max_steps}.", details={"field": "steps"})
    params["steps"] = steps
    params["seed"] = req.seed if req.seed is not None else secrets.randbelow(MAX_SEED + 1)
    params["output_format"] = req.output_format

    if isinstance(req, VideoGenerationRequest):
        width, height = _size(req, model, profile, limits, required=True)
        allowed_fps = c.get("fps")
        fps = req.fps if req.fps is not None else int(defaults.get("fps", 24))
        if allowed_fps and fps not in allowed_fps:
            raise CapabilityError(
                f"'{model.id}' generates at {', '.join(map(str, allowed_fps))} fps only.",
                details={"model": model.id, "fps": fps},
            )
        if req.audio and not c.get("audio", False):
            raise CapabilityError(f"'{model.id}' does not generate audio; set audio=false.")
        refs = req.reference_image_ids
        max_refs = min(int(c.get("max_reference_images", 0)), limits.max_reference_images)
        if len(refs) > max_refs:
            raise CapabilityError(f"'{model.id}' takes at most {max_refs} reference images.")
        params.update(
            width=width,
            height=height,
            fps=fps,
            num_frames=_frames(req, model, fps, limits),
            audio=req.audio,
            start_image_id=req.start_image_id,
            end_image_id=req.end_image_id,
            reference_image_ids=list(refs),
        )
    else:
        edit = isinstance(req, ImageEditRequest)
        width, height = _size(req, model, profile, limits, required=not edit)
        params.update(width=width, height=height)
        if isinstance(req, ImageEditRequest):
            max_images = min(int(c.get("max_input_images", 1)), limits.max_edit_images)
            if len(req.image_ids) > max_images:
                raise CapabilityError(f"'{model.id}' takes at most {max_images} input images.")
            params["image_ids"] = list(req.image_ids)
    params["task"] = task
    return params
