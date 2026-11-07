"""Backends. The real ones import torch/diffusers lazily, inside their methods,
so the API, the mock backend and the tests never need the inference stack."""

from __future__ import annotations

from typing import TYPE_CHECKING

from .base import Artifact, GenerationRequest, Provider

if TYPE_CHECKING:
    from ..config import Settings
    from ..registry import ModelSpec, ProfileSpec
    from .diarize import Diarizer

__all__ = ["Artifact", "GenerationRequest", "Provider", "create_diarizer", "create_provider"]


def create_provider(settings: Settings, model: ModelSpec, profile: ProfileSpec) -> Provider:
    if settings.backend == "mock":
        from .mock import MockProvider

        return MockProvider(settings, model, profile)
    if model.provider == "qwen-image":
        from .qwen_image import QwenImageProvider

        return QwenImageProvider(settings, model, profile)
    if model.provider == "qwen-image-edit":
        from .qwen_image import QwenImageEditProvider

        return QwenImageEditProvider(settings, model, profile)
    if model.provider == "qwen-image-21":
        from .qwen_image21 import QwenImage21Provider

        return QwenImage21Provider(settings, model, profile)
    if model.provider == "minimax-h3":
        from .minimax_h3 import MiniMaxH3Provider

        return MiniMaxH3Provider(settings, model, profile)
    if model.provider == "whisper":
        from .transcribe import WhisperProvider

        return WhisperProvider(settings, model, profile)
    if model.provider == "qwen3-asr":
        from .transcribe import Qwen3AsrProvider

        return Qwen3AsrProvider(settings, model, profile)
    raise ValueError(f"no provider for {model.provider}")


def create_diarizer(settings: Settings) -> Diarizer:
    """The registry's first speaker-diarization model, for `diarize: true`."""
    model = settings.registry.default_for("speaker-diarization")
    profile = model.profile(None)
    if settings.backend == "mock":
        from .mock import MockDiarizer

        return MockDiarizer(settings, model, profile)
    if model.provider == "nemotron-diarization":
        from .diarize import NemotronDiarizer

        return NemotronDiarizer(settings, model, profile)
    raise ValueError(f"no diarizer for {model.provider}")
