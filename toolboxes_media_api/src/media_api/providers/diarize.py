"""Speaker diarization: who speaks when, for `diarize: true` transcriptions.

NVIDIA's Nemotron-3-Diarization through transformers (a Sortformer: up to
eight speakers, numbered in order of first appearance). It runs once over the
whole recording in its offline mode — the forward pass cuts the audio into
30-second chunks itself and carries a speaker cache from chunk to chunk, so a
speaker keeps their number across hours — and returns per-10-ms activity,
which media_api.speech turns into turns and then into segment labels.
"""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Any

import numpy as np

from ..audio import SAMPLE_RATE
from ..speech import Turn, turns_from_activity

if TYPE_CHECKING:
    from ..config import Settings
    from ..registry import ModelSpec, ProfileSpec


class Diarizer:
    def __init__(self, settings: Settings, model: ModelSpec, profile: ProfileSpec) -> None:
        self.settings = settings
        self.model = model
        self.profile = profile

    def load(self) -> None:
        raise NotImplementedError

    def turns(self, samples: np.ndarray) -> list[Turn]:
        raise NotImplementedError


class NemotronDiarizer(Diarizer):
    def load(self) -> None:
        import torch
        from transformers import AutoModelForAudioFrameClassification, AutoProcessor

        base = Path(self.settings.models_dir) / self.model.base.path
        device = self.settings.device if torch.cuda.is_available() or self.settings.device == "cpu" else "cpu"
        self.device = device
        self.processor: Any = AutoProcessor.from_pretrained(base, local_files_only=True)
        # FP32 as released: 0.4 GB, and the speaker cache's scores stay as trained.
        self.net: Any = AutoModelForAudioFrameClassification.from_pretrained(
            base, dtype=torch.float32, local_files_only=True
        ).to(device)
        self.net.eval()

    def turns(self, samples: np.ndarray) -> list[Turn]:
        import torch

        if samples.size == 0:
            return []
        inputs = self.processor(samples, sampling_rate=SAMPLE_RATE).to(self.device)
        with torch.inference_mode():
            logits = self.net(**inputs).logits[0]
        valid = int(inputs["attention_mask"][0].sum())
        probs = logits[:valid].sigmoid().float().cpu().numpy()
        frame = self.processor.feature_extractor.hop_length / self.processor.feature_extractor.sampling_rate
        return turns_from_activity(probs, frame)
