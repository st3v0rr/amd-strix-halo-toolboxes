"""Backends. The real ones import torch/diffusers lazily, inside their methods,
so the API, the mock backend and the tests never need the inference stack."""

from __future__ import annotations

from typing import TYPE_CHECKING

from .base import Artifact, GenerationRequest, Provider

if TYPE_CHECKING:
    from ..config import Settings
    from ..registry import ModelSpec, ProfileSpec

__all__ = ["Artifact", "GenerationRequest", "Provider", "create_provider"]


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
    if model.provider == "minimax-h3":
        from .minimax_h3 import MiniMaxH3Provider

        return MiniMaxH3Provider(settings, model, profile)
    raise ValueError(f"no provider for {model.provider}")
