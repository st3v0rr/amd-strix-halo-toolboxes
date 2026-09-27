"""The contract between the job queue and a model backend."""

from __future__ import annotations

import abc
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from ..config import Settings
    from ..jobs import JobContext
    from ..registry import ModelSpec, ProfileSpec


@dataclass(frozen=True)
class GenerationRequest:
    task: str
    prompt: str
    negative_prompt: str | None
    width: int | None
    height: int | None
    steps: int
    guidance: float | None
    seed: int
    output_format: str
    output_dir: Path
    images: tuple[Path, ...] = ()
    start_image: Path | None = None
    end_image: Path | None = None
    reference_images: tuple[Path, ...] = ()
    num_frames: int | None = None
    fps: int | None = None
    audio: bool = True
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class Artifact:
    path: Path
    content_type: str
    width: int
    height: int
    frames: int | None = None
    fps: int | None = None
    has_audio: bool = False

    def describe(self, job_id: str) -> dict[str, Any]:
        data: dict[str, Any] = {
            "url": f"/api/v1/jobs/{job_id}/result",
            "filename": self.path.name,
            "content_type": self.content_type,
            "bytes": self.path.stat().st_size,
            "width": self.width,
            "height": self.height,
        }
        if self.frames is not None:
            data.update(
                frames=self.frames,
                fps=self.fps,
                duration_seconds=round(self.frames / (self.fps or 1), 3),
                has_audio=self.has_audio,
            )
        return data


class Provider(abc.ABC):
    """One loaded (model, profile). Created by the lifecycle manager, used by
    one worker thread at a time, and dropped when another model is needed."""

    def __init__(self, settings: Settings, model: ModelSpec, profile: ProfileSpec) -> None:
        self.settings = settings
        self.model = model
        self.profile = profile

    @abc.abstractmethod
    def load(self, ctx: JobContext) -> None:
        """Load everything the profile needs. Called once, lazily, from a job."""

    @abc.abstractmethod
    def generate(self, request: GenerationRequest, ctx: JobContext) -> Artifact:
        """Run one generation and write its output under request.output_dir."""

    def unload(self) -> None:  # noqa: B027 - optional hook, the default is enough for most
        """Drop every reference to model objects; the manager collects afterwards."""
