"""Speech-to-text without the inference stack: windows, transcripts, output files.

Shared by the real providers and the mock, so the GPU-less tests run the same
windowing, offsetting and formatting a real job does. A provider only turns a
batch of windows into text (and, where the model can, timestamps relative to
its window); everything here is plain numpy.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

from .audio import SAMPLE_RATE

TRANSCRIPT_FORMATS = {
    "json": "application/json",
    "txt": "text/plain; charset=utf-8",
    "srt": "application/x-subrip; charset=utf-8",
    "vtt": "text/vtt; charset=utf-8",
}
FRAME_SECONDS = 0.05  # energy is measured in 50 ms frames
SEARCH_SECONDS = 8.0  # a cut looks for the quietest frame in the window's last 8 s
SILENCE_DBFS = -45.0  # a window whose loudest frame stays below this is skipped
SENTENCE_END = re.compile(r"(?<=[.!?。！？])\s+")


@dataclass(frozen=True)
class Window:
    start: int  # sample offsets into the whole recording
    end: int

    @property
    def start_seconds(self) -> float:
        return self.start / SAMPLE_RATE

    @property
    def seconds(self) -> float:
        return (self.end - self.start) / SAMPLE_RATE


@dataclass
class Word:
    start: float
    end: float
    text: str


@dataclass
class Segment:
    start: float
    end: float
    text: str
    words: list[Word] = field(default_factory=list)


@dataclass
class WindowResult:
    """What a provider returns for one window; times are relative to the window."""

    text: str
    language: str | None = None
    segments: list[Segment] = field(default_factory=list)


def _frame_dbfs(samples: np.ndarray) -> np.ndarray:
    size = int(FRAME_SECONDS * SAMPLE_RATE)
    usable = samples[: samples.size // size * size]
    if usable.size == 0:
        return np.full(1, -120.0, dtype=np.float32)
    rms = np.sqrt(np.mean(usable.reshape(-1, size) ** 2, axis=1))
    return (20 * np.log10(np.maximum(rms, 1e-6))).astype(np.float32)


def split_windows(samples: np.ndarray, max_seconds: float) -> list[Window]:
    """Cut the recording into windows of at most `max_seconds`, each cut at the
    quietest moment near its end, and drop windows that are silence throughout."""
    total = int(samples.size)
    limit = int(max_seconds * SAMPLE_RATE)
    frame = int(FRAME_SECONDS * SAMPLE_RATE)
    windows: list[Window] = []
    start = 0
    while start < total:
        # A window starts just before the first audible frame: leading silence
        # is where Whisper invents text, and it wastes the 30 seconds.
        ahead = _frame_dbfs(samples[start : min(total, start + limit)])
        loud = np.flatnonzero(ahead >= SILENCE_DBFS)
        if loud.size == 0:
            start = min(total, start + limit)
            continue
        start += max(0, int(loud[0]) - 1) * frame
        end = min(total, start + limit)
        if end < total:
            search_from = max(start + frame, end - int(SEARCH_SECONDS * SAMPLE_RATE))
            energy = _frame_dbfs(samples[search_from:end])
            quietest = int(np.argmin(energy))
            end = search_from + quietest * frame + frame // 2
        windows.append(Window(start, end))
        start = end
    return windows


def merge(windows: Sequence[Window], results: Sequence[WindowResult]) -> list[Segment]:
    """One timeline: each window's segments shifted by the window's start. A
    window without timestamps becomes one segment spanning the window."""
    segments: list[Segment] = []
    for window, result in zip(windows, results, strict=True):
        offset = window.start_seconds
        if not result.text.strip():
            continue
        parts = result.segments or [Segment(0.0, window.seconds, result.text.strip())]
        for part in parts:
            text = part.text.strip()
            if not text:
                continue
            start = round(offset + max(0.0, part.start), 3)
            end = round(offset + min(max(part.end, part.start), window.seconds), 3)
            words = [
                Word(
                    round(offset + min(max(0.0, w.start), window.seconds), 3),
                    round(offset + min(max(w.end, w.start), window.seconds), 3),
                    w.text,
                )
                for w in part.words
            ]
            segments.append(Segment(start, max(start, end), text, words))
    return segments


def sentences_from_words(text: str, words: Sequence[Word]) -> list[Segment]:
    """Sentence segments from a transcript and its aligned words.

    Forced aligners return words without punctuation, in transcript order; the
    transcript's sentences are re-attached to them by counting words, which is
    the same splitting the aligner applied.
    """
    segments: list[Segment] = []
    position = 0
    for sentence in (s.strip() for s in SENTENCE_END.split(text.strip())):
        if not sentence:
            continue
        count = len([t for t in re.split(r"\s+", sentence) if re.search(r"\w", t)])
        chunk = list(words[position : position + count])
        position += count
        if chunk:
            segments.append(Segment(chunk[0].start, chunk[-1].end, sentence, chunk))
        elif segments:
            segments[-1].text += " " + sentence
    if position < len(words) and segments:
        segments[-1].words.extend(words[position:])
        segments[-1].end = words[-1].end
    return segments


def majority_language(results: Sequence[WindowResult]) -> str | None:
    counts: dict[str, int] = {}
    for result in results:
        if result.language:
            counts[result.language] = counts.get(result.language, 0) + 1
    return max(counts, key=lambda k: counts[k]) if counts else None


def transcribe_windows(
    samples: np.ndarray,
    window_seconds: float,
    batch_size: int,
    run_batch: Callable[[list[np.ndarray]], list[WindowResult]],
    progress: Callable[[float], None],
) -> tuple[list[Window], list[WindowResult]]:
    windows = split_windows(samples, window_seconds)
    results: list[WindowResult] = []
    for first in range(0, len(windows), max(1, batch_size)):
        batch = windows[first : first + batch_size]
        out = run_batch([samples[w.start : w.end] for w in batch])
        if len(out) != len(batch):
            raise RuntimeError(f"provider returned {len(out)} results for {len(batch)} windows")
        results.extend(out)
        progress(len(results) / len(windows))
    if not windows:
        progress(1.0)
    return windows, results


def transcript_document(
    segments: Sequence[Segment],
    *,
    model: str,
    profile: str,
    language: str | None,
    duration: float,
    words: bool,
) -> dict[str, Any]:
    data: dict[str, Any] = {
        "object": "transcription",
        "model": model,
        "profile": profile,
        "language": language,
        "duration_seconds": round(duration, 3),
        "text": " ".join(s.text for s in segments),
        "segments": [
            {"id": index, "start": s.start, "end": s.end, "text": s.text} for index, s in enumerate(segments)
        ],
    }
    if words:
        data["words"] = [{"start": w.start, "end": w.end, "text": w.text} for s in segments for w in s.words]
    return data


def _clock(seconds: float, separator: str) -> str:
    millis = round(seconds * 1000)
    hours, rest = divmod(millis, 3_600_000)
    minutes, rest = divmod(rest, 60_000)
    secs, millis = divmod(rest, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}{separator}{millis:03d}"


def render(document: dict[str, Any], output_format: str) -> str:
    segments = document["segments"]
    if output_format == "json":
        return json.dumps(document, ensure_ascii=False, indent=1) + "\n"
    if output_format == "txt":
        return "".join(f"{s['text']}\n" for s in segments)
    if output_format == "srt":
        return "\n".join(
            f"{i + 1}\n{_clock(s['start'], ',')} --> {_clock(s['end'], ',')}\n{s['text']}\n"
            for i, s in enumerate(segments)
        )
    if output_format == "vtt":
        body = "\n".join(
            f"{_clock(s['start'], '.')} --> {_clock(s['end'], '.')}\n{s['text']}\n" for s in segments
        )
        return "WEBVTT\n\n" + body
    raise ValueError(f"unknown transcript format {output_format!r}")


def write_transcript(document: dict[str, Any], directory: Path, output_format: str) -> tuple[Path, str]:
    path = directory / f"output.{output_format}"
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".tmp-", suffix=path.suffix)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(render(document, output_format))
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise
    return path, TRANSCRIPT_FORMATS[output_format]
