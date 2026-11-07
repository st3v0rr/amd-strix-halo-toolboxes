"""Speech-to-text providers: one generate(), the model only fills run_batch().

The recording is cut into windows at pauses (media_api.speech), the windows go
through the model in batches with progress and cancellation between batches,
and the results land on one timeline in seconds from the start. Whisper and
Qwen3-ASR load through transformers, imported lazily like everything else
that needs torch.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from pathlib import Path
from typing import TYPE_CHECKING, Any

import numpy as np

from ..audio import SAMPLE_RATE, read_wav
from ..errors import ProviderError
from ..speech import (
    Segment,
    WindowResult,
    Word,
    assign_speakers,
    majority_language,
    merge,
    sentences_from_words,
    transcribe_windows,
    transcript_document,
    write_transcript,
)
from .base import Artifact, GenerationRequest, Provider

if TYPE_CHECKING:
    from ..jobs import JobContext

log = logging.getLogger("media_api.speech")
DTYPES = {"bf16": "bfloat16", "fp16": "float16", "fp32": "float32"}


class SpeechProvider(Provider):
    _diarizer: Any = None

    def diarizer(self) -> Any:
        """Loaded on the first diarized job and kept with the ASR model (0.4 GB)."""
        if self._diarizer is None:
            from . import create_diarizer

            diarizer = create_diarizer(self.settings)
            diarizer.load()
            self._diarizer = diarizer
        return self._diarizer

    def run_batch(
        self, batch: list[np.ndarray], language: str | None, prompt: str | None, words: bool
    ) -> list[WindowResult]:
        raise NotImplementedError

    def generate(self, request: GenerationRequest, ctx: JobContext) -> Artifact:
        if request.audio_input is None:
            raise ProviderError("missing_audio", "A transcription needs an audio upload.")
        samples = read_wav(request.audio_input)
        duration = samples.size / SAMPLE_RATE
        window_seconds = float(self.model.constraints.get("window_seconds", 30))
        defaults = {**self.model.defaults, **self.profile.defaults}
        batch_size = int(defaults.get("batch_size", 1))
        words = request.timestamps == "word"
        prompt = request.prompt or None

        def run(batch: list[np.ndarray]) -> list[WindowResult]:
            ctx.check_cancelled()
            return self.run_batch(batch, request.language, prompt, words)

        windows, results = transcribe_windows(
            samples, window_seconds, batch_size, run, lambda done: ctx.report("transcribing", done)
        )
        segments = merge(windows, results)
        speakers = None
        if request.diarize:
            ctx.check_cancelled()
            ctx.report("diarizing", 0.0)
            turns = self.diarizer().turns(samples)
            speakers = assign_speakers(segments, turns)
            ctx.report("diarizing", 1.0)
        ctx.report("encoding", 1.0)
        language = request.language or majority_language(results)
        document = transcript_document(
            segments,
            model=self.model.id,
            profile=self.profile.id,
            language=language,
            duration=duration,
            words=words,
            speakers=speakers,
        )
        path, content_type = write_transcript(document, request.output_dir, request.output_format)
        return Artifact(
            path,
            content_type,
            duration_seconds=duration,
            summary={
                "language": language,
                "segments": len(segments),
                **({"speakers": len(speakers)} if speakers is not None else {}),
            },
        )


def _device_and_dtype(settings: Any, storage: str) -> tuple[Any, Any]:
    import torch

    device = settings.device if torch.cuda.is_available() or settings.device == "cpu" else "cpu"
    dtype = getattr(torch, DTYPES.get(storage, "bfloat16"))
    return device, dtype


class WhisperProvider(SpeechProvider):
    """Whisper through transformers, one 30-second window per batch item.

    Windows are cut at pauses and at most 30 s, so every window is short-form
    Whisper; the segment timestamps it predicts are relative to the window.
    """

    def load(self, ctx: JobContext) -> None:
        from transformers import AutoProcessor, WhisperForConditionalGeneration

        base = Path(self.settings.models_dir) / self.model.base.path
        component = self.profile.components["model"]
        self.device, self.dtype = _device_and_dtype(self.settings, component.storage)
        ctx.report("loading_model", 0.1)
        self.processor = AutoProcessor.from_pretrained(base, local_files_only=True)
        self.whisper = WhisperForConditionalGeneration.from_pretrained(
            base, dtype=self.dtype, local_files_only=True
        ).to(self.device)
        self.whisper.eval()
        ctx.report("loading_model", 1.0)

    def unload(self) -> None:
        for name in ("whisper", "processor", "_diarizer"):
            self.__dict__.pop(name, None)

    def run_batch(
        self, batch: list[np.ndarray], language: str | None, prompt: str | None, words: bool
    ) -> list[WindowResult]:
        import torch

        features = self.processor(
            batch, sampling_rate=SAMPLE_RATE, return_tensors="pt", return_attention_mask=True
        )
        input_features = features.input_features.to(self.device, self.dtype)
        tokenizer = self.processor.tokenizer
        with torch.inference_mode():
            if language:
                languages = [language] * len(batch)
            else:
                # Detected per window, then forced: a window never switches
                # language halfway, and the result can name what it heard.
                ids = self.whisper.detect_language(input_features)
                languages = [tokenizer.convert_ids_to_tokens(int(i)).strip("<|>") for i in ids]
            kwargs: dict[str, Any] = {
                "task": "transcribe",
                "language": languages,
                "return_timestamps": True,
                "attention_mask": features.attention_mask.to(self.device),
                # OpenAI's fallback: decode again at a higher temperature when the
                # text repeats itself (compression ratio) or the model is unsure.
                # Without it Whisper can loop on one phrase for a whole window.
                "temperature": (0.0, 0.2, 0.4, 0.6, 0.8, 1.0),
                "compression_ratio_threshold": 1.35,
                "logprob_threshold": -1.0,
                "no_speech_threshold": 0.6,
            }
            if prompt:
                kwargs["prompt_ids"] = torch.tensor(self.processor.get_prompt_ids(prompt), device=self.device)
                kwargs["prompt_condition_type"] = "first-segment"
            out = self.whisper.generate(input_features, **kwargs)
        sequences = out if isinstance(out, torch.Tensor) else out["sequences"]
        results = []
        for row, code in zip(sequences, languages, strict=True):
            decoded = tokenizer.decode(row, skip_special_tokens=True, output_offsets=True)
            segments = [
                Segment(float(o["timestamp"][0]), float(o["timestamp"][1] or 0.0), o["text"])
                for o in decoded.get("offsets", [])
                if o["timestamp"][0] is not None
            ]
            results.append(WindowResult(text=decoded["text"].strip(), language=code, segments=segments))
        return results


class Qwen3AsrProvider(SpeechProvider):
    """Qwen3-ASR through transformers, with Qwen3-ForcedAligner for timestamps.

    The ASR model writes the text of each window; the aligner then places each
    word of that text in the window's audio, and sentences are rebuilt from the
    words. Languages the aligner does not cover keep one segment per window.
    """

    def load(self, ctx: JobContext) -> None:
        from transformers import (
            AutoProcessor,
            Qwen3ASRForConditionalGeneration,
            Qwen3ASRForTokenClassification,
        )

        models_dir = Path(self.settings.models_dir)
        base = models_dir / self.model.base.path
        component = self.profile.components["model"]
        self.device, self.dtype = _device_and_dtype(self.settings, component.storage)
        ctx.report("loading_model", 0.1)
        self.processor = AutoProcessor.from_pretrained(base, local_files_only=True)
        self.asr = Qwen3ASRForConditionalGeneration.from_pretrained(
            base, dtype=self.dtype, local_files_only=True
        ).to(self.device)
        self.asr.eval()
        self.aligner = None
        aligner_spec = self.profile.components.get("aligner")
        if aligner_spec is not None and aligner_spec.file is not None:
            ctx.report("loading_model", 0.6)
            aligner_dir = models_dir / aligner_spec.file.path
            _, aligner_dtype = _device_and_dtype(self.settings, aligner_spec.storage)
            self.aligner_processor = AutoProcessor.from_pretrained(aligner_dir, local_files_only=True)
            self.aligner = Qwen3ASRForTokenClassification.from_pretrained(
                aligner_dir, dtype=aligner_dtype, local_files_only=True
            ).to(self.device)
            self.aligner.eval()
        ctx.report("loading_model", 1.0)

    def unload(self) -> None:
        for name in ("asr", "processor", "aligner", "aligner_processor", "_diarizer"):
            self.__dict__.pop(name, None)

    def run_batch(
        self, batch: list[np.ndarray], language: str | None, prompt: str | None, words: bool
    ) -> list[WindowResult]:
        import torch

        inputs = self.processor.apply_transcription_request(
            audio=list(batch),
            language=language,
            prompt=[prompt] * len(batch) if prompt else None,
            sampling_rate=SAMPLE_RATE,
        ).to(self.device)
        inputs["input_features"] = inputs["input_features"].to(self.dtype)
        max_new = int(self.model.defaults.get("max_new_tokens", 1024))
        with torch.inference_mode():
            out = self.asr.generate(**inputs, max_new_tokens=max_new, do_sample=False)
        generated = out[:, inputs["input_ids"].shape[1] :]
        results: list[WindowResult] = []
        for row in generated:
            parsed = self.processor.decode(row, return_format="parsed")
            results.append(
                WindowResult(
                    text=str(parsed.get("transcription") or "").strip(),
                    language=language or _language_code(parsed.get("language")),
                )
            )
        self._align(batch, results)
        return results

    def _align(self, batch: Sequence[np.ndarray], results: list[WindowResult]) -> None:
        if self.aligner is None:
            return
        aligned = set(self.model.constraints.get("aligned_languages") or ())
        todo = [i for i, r in enumerate(results) if r.text and r.language in aligned]
        if not todo:
            return
        import torch

        try:
            inputs, word_lists = self.aligner_processor.prepare_forced_aligner_inputs(
                audio=[batch[i] for i in todo],
                transcript=[results[i].text for i in todo],
                language=[results[i].language for i in todo],
                sampling_rate=SAMPLE_RATE,
            )
        except ImportError as exc:  # Japanese/Korean word splitting needs extra packages
            log.warning("forced alignment skipped: %s", exc)
            return
        inputs = inputs.to(self.device)
        inputs["input_features"] = inputs["input_features"].to(self.aligner.dtype)
        with torch.inference_mode():
            logits = self.aligner(**inputs).logits
        timings = self.aligner_processor.decode_forced_alignment(
            logits, inputs["input_ids"], word_lists, timestamp_token_id=self.aligner.config.timestamp_token_id
        )
        for index, items in zip(todo, timings, strict=True):
            words = [Word(float(w["start_time"]), float(w["end_time"]), str(w["text"])) for w in items]
            if words:
                results[index].segments = sentences_from_words(results[index].text, words)


def _language_code(name: Any) -> str | None:
    if not name:
        return None
    from transformers.models.qwen3_asr.processing_qwen3_asr import LANGUAGE_CODE_TO_NAME

    wanted = str(name).strip().lower()
    for code, full in LANGUAGE_CODE_TO_NAME.items():
        if full.lower() == wanted or code == wanted:
            return code
    return None
