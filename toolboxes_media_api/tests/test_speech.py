"""Speech-to-text: audio uploads, windowing, the timeline and output formats.

All against the mock backend: the windowing, offsets and formats are the real
code, only the words are invented. The real models are exercised by hand
(README, "Speech-to-text") since their checkpoints are gigabytes.
"""

from __future__ import annotations

import io
import json
import os
import time
import wave
from pathlib import Path

import av
import numpy as np
import pytest
import yaml

from media_api.audio import SAMPLE_RATE, decode_to_wav
from media_api.errors import ConfigError, PayloadTooLarge, UnsupportedMediaType
from media_api.registry import _default_model_data, load_registry
from media_api.speech import (
    Segment,
    Window,
    WindowResult,
    Word,
    merge,
    render,
    sentences_from_words,
    split_windows,
    transcript_document,
)

from .conftest import AUTH


def tone(seconds: float, freq: float = 440.0, level: float = 0.3) -> np.ndarray:
    t = np.arange(int(seconds * SAMPLE_RATE), dtype=np.float32) / SAMPLE_RATE
    return (np.sin(2 * np.pi * freq * t) * level).astype(np.float32)


def silence(seconds: float) -> np.ndarray:
    return np.zeros(int(seconds * SAMPLE_RATE), dtype=np.float32)


def encode(samples: np.ndarray, fmt: str = "mp4", codec: str = "aac") -> bytes:
    """Samples as a real compressed file, the way a client would send them."""
    buffer = io.BytesIO()
    with av.open(buffer, "w", format=fmt) as out:
        stream = out.add_stream(codec, rate=SAMPLE_RATE)
        stream.layout = "mono"
        frame = av.AudioFrame.from_ndarray(
            (samples * 32767).astype(np.int16)[None, :], format="s16", layout="mono"
        )
        frame.sample_rate = SAMPLE_RATE
        for packet in stream.encode(frame):
            out.mux(packet)
        for packet in stream.encode(None):
            out.mux(packet)
    return buffer.getvalue()


def wav_bytes(samples: np.ndarray) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(SAMPLE_RATE)
        out.writeframes((samples * 32767).astype("<i2").tobytes())
    return buffer.getvalue()


def upload_audio(client, data: bytes, content_type: str = "audio/mp4", name: str = "talk.m4a"):  # type: ignore[no-untyped-def]
    return client.post("/api/v1/audio/uploads", headers=AUTH, files={"file": (name, data, content_type)})


def wait(client, job_id: str, timeout: float = 20.0) -> dict:  # type: ignore[no-untyped-def]
    deadline = time.time() + timeout
    while time.time() < deadline:
        job = client.get(f"/api/v1/jobs/{job_id}", headers=AUTH).json()
        if job["status"] not in ("queued", "running"):
            return job
        time.sleep(0.02)
    raise AssertionError("job did not finish")


# -- windows and the timeline -------------------------------------------------


def test_windows_are_cut_at_pauses_and_skip_silence():
    # 25 s of sound, a 0.5 s pause at 25 s, 10 s more, 40 s of silence, 5 s of sound.
    samples = np.concatenate([tone(25), silence(0.5), tone(10), silence(40), tone(5)])
    windows = split_windows(samples, 30)
    starts = [round(w.start_seconds, 2) for w in windows]
    ends = [round((w.end) / SAMPLE_RATE, 2) for w in windows]
    # The first cut lands in the pause (25.0-25.5 s), not at the 30 s mark.
    assert 25.0 <= ends[0] <= 25.5
    # The silence is never sent to the model: the last window starts at the last sound.
    assert 75.4 <= starts[-1] <= 75.5
    assert all(w.seconds <= 30 for w in windows)
    assert not any(55.5 < s < 75.4 for s in starts)


def test_a_silent_recording_has_no_windows():
    assert split_windows(silence(90), 30) == []


def test_merge_puts_every_window_on_one_timeline():
    windows = [Window(0, 10 * SAMPLE_RATE), Window(40 * SAMPLE_RATE, 55 * SAMPLE_RATE)]
    results = [
        WindowResult("a", "de", [Segment(1.0, 4.0, "a")]),
        WindowResult("b", "de", [Segment(2.5, 99.0, "b", [Word(2.5, 3.0, "b")])]),
    ]
    segments = merge(windows, results)
    assert [(s.start, s.end, s.text) for s in segments] == [(1.0, 4.0, "a"), (42.5, 55.0, "b")]
    assert (segments[1].words[0].start, segments[1].words[0].end) == (42.5, 43.0)


def test_a_window_without_timestamps_spans_the_window():
    segments = merge([Window(16000, 5 * 16000)], [WindowResult("hallo welt", "de")])
    assert [(s.start, s.end) for s in segments] == [(1.0, 5.0)]


def test_sentences_are_rebuilt_from_aligned_words():
    text = "Guten Morgen zusammen. Wie geht's? Gut, danke!"
    words = [
        Word(0.0, 0.4, "Guten"),
        Word(0.4, 0.9, "Morgen"),
        Word(0.9, 1.5, "zusammen"),
        Word(2.0, 2.2, "Wie"),
        Word(2.2, 2.6, "geht's"),
        Word(3.0, 3.3, "Gut"),
        Word(3.3, 3.8, "danke"),
    ]
    segments = sentences_from_words(text, words)
    assert [(s.text, s.start, s.end) for s in segments] == [
        ("Guten Morgen zusammen.", 0.0, 1.5),
        ("Wie geht's?", 2.0, 2.6),
        ("Gut, danke!", 3.0, 3.8),
    ]


def test_output_formats():
    doc = transcript_document(
        [Segment(1.5, 3_725.25, "Hallo"), Segment(3_725.25, 3_726.0, "Welt")],
        model="m",
        profile="p",
        language="de",
        duration=3_726.0,
        words=False,
    )
    assert json.loads(render(doc, "json"))["text"] == "Hallo Welt"
    assert render(doc, "txt") == "Hallo\nWelt\n"
    srt = render(doc, "srt")
    assert srt.startswith("1\n00:00:01,500 --> 01:02:05,250\nHallo\n")
    vtt = render(doc, "vtt")
    assert vtt.startswith("WEBVTT\n\n00:00:01.500 --> 01:02:05.250\nHallo\n")


# -- decoding -----------------------------------------------------------------


def test_decoding_stops_at_the_length_limit(tmp_path: Path):
    source = tmp_path / "long.m4a"
    source.write_bytes(encode(tone(5)))
    with pytest.raises(PayloadTooLarge):
        decode_to_wav(source, tmp_path / "out.wav", "mp4", max_seconds=2)
    assert not (tmp_path / "out.wav").exists()
    assert not list(tmp_path.glob(".tmp-*"))


def test_only_the_declared_demuxer_reads_the_file(tmp_path: Path):
    source = tmp_path / "x"
    source.write_bytes(wav_bytes(tone(1)))
    with pytest.raises(UnsupportedMediaType):
        decode_to_wav(source, tmp_path / "out.wav", "mp4", max_seconds=10)
    assert decode_to_wav(source, tmp_path / "out.wav", "wav", max_seconds=10) == pytest.approx(1.0)


# -- the API ------------------------------------------------------------------


@pytest.mark.parametrize(
    ("data", "content_type"),
    [
        (encode(tone(2)), "audio/mp4"),
        (encode(tone(2)), "audio/x-m4a"),
        (wav_bytes(tone(2)), "audio/wav"),
        (encode(tone(2), "flac", "flac"), "audio/flac"),
    ],
    ids=["m4a-as-mp4", "m4a", "wav", "flac"],
)
def test_audio_uploads_are_stored_as_16k_mono_wav(client, data, content_type):
    response = upload_audio(client, data, content_type)
    assert response.status_code == 201, response.text
    info = response.json()
    assert info["id"].startswith("aud_") and info["content_type"] == "audio/wav"
    # AAC adds its encoder delay (~0.1 s) to the decoded length.
    assert info["duration_seconds"] == pytest.approx(2.0, abs=0.15)
    stored = client.get(info["url"], headers=AUTH)
    assert stored.status_code == 200
    with wave.open(io.BytesIO(stored.content)) as handle:
        assert (handle.getnchannels(), handle.getframerate(), handle.getsampwidth()) == (1, 16000, 2)


@pytest.mark.parametrize(
    ("data", "content_type", "status"),
    [
        (b"not audio at all", "audio/mp4", 415),
        (wav_bytes(tone(1)), "audio/mp4", 415),  # declared type does not match
        (wav_bytes(tone(1)), "image/png", 415),
        (wav_bytes(tone(1)), "text/plain", 415),
    ],
    ids=["garbage", "wav-declared-m4a", "wav-as-png", "wav-as-text"],
)
def test_bad_audio_uploads_rejected(client, data, content_type, status):
    response = upload_audio(client, data, content_type)
    assert response.status_code == status, response.text


def test_audio_limits(make_client):
    client = make_client(MEDIA_MAX_AUDIO_SECONDS="1")
    assert upload_audio(client, encode(tone(3))).status_code == 413
    client = make_client(MEDIA_MAX_AUDIO_UPLOAD_BYTES="2048")
    assert upload_audio(client, wav_bytes(tone(2)), "audio/wav").status_code == 413


def test_audio_needs_a_key(client):
    assert client.post("/api/v1/audio/uploads", files={"file": ("a", b"x", "audio/wav")}).status_code == 401
    body = {"audio_id": "aud_" + "0" * 32}
    assert client.post("/api/v1/audio/transcriptions", json=body).status_code == 401


def test_transcription_end_to_end(client):
    recording = np.concatenate([tone(12), silence(40), tone(8)])
    audio_id = upload_audio(client, encode(recording)).json()["id"]
    response = client.post(
        "/api/v1/audio/transcriptions",
        headers=AUTH,
        json={"audio_id": audio_id, "language": "de", "timestamps": "word"},
    )
    # The first speech model is Whisper, which has no word timestamps.
    assert response.status_code == 422
    assert "segment timestamps only" in response.json()["error"]["message"]
    response = client.post(
        "/api/v1/audio/transcriptions",
        headers=AUTH,
        json={"audio_id": audio_id, "model": "qwen3-asr-1.7b", "language": "de", "timestamps": "word"},
    )
    assert response.status_code == 202, response.text
    job = wait(client, response.json()["id"])
    assert job["status"] == "succeeded", job
    assert job["task"] == "speech-to-text" and job["result"]["language"] == "de"
    doc = client.get(job["result"]["url"], headers=AUTH).json()
    assert doc["duration_seconds"] == pytest.approx(60.0, abs=0.15)
    # Two windows of sound, the 40 s of silence skipped; the second starts at ~52 s.
    assert len(doc["segments"]) == 2
    assert doc["segments"][1]["start"] == pytest.approx(52.0, abs=0.2)
    assert doc["words"][-1]["end"] <= doc["duration_seconds"]


@pytest.mark.parametrize(("fmt", "start"), [("srt", "1\n00:00:"), ("vtt", "WEBVTT"), ("txt", "mock")])
def test_transcription_formats(client, fmt, start):
    audio_id = upload_audio(client, encode(tone(3))).json()["id"]
    job_id = client.post(
        "/api/v1/audio/transcriptions",
        headers=AUTH,
        json={"audio_id": audio_id, "output_format": fmt},
    ).json()["id"]
    job = wait(client, job_id)
    assert job["status"] == "succeeded"
    assert client.get(job["result"]["url"], headers=AUTH).text.startswith(start)


@pytest.mark.parametrize(
    ("body", "status"),
    [
        ({"audio_id": "upl_" + "0" * 32}, 422),  # an image upload is not audio
        ({"audio_id": "aud_" + "0" * 32}, 422),  # unknown upload
        ({"audio_id": "AUDIO", "language": "de"}, 422),
        ({"audio_id": "aud_" + "0" * 32, "language": "german"}, 422),
        ({"audio_id": "aud_" + "0" * 32, "model": "qwen-image-2512"}, 422),
    ],
)
def test_transcription_requests_are_checked_before_queueing(client, body, status):
    response = client.post("/api/v1/audio/transcriptions", headers=AUTH, json=body)
    assert response.status_code == status, response.text


def test_unsupported_language_is_refused(client):
    audio_id = upload_audio(client, encode(tone(1))).json()["id"]
    response = client.post(
        "/api/v1/audio/transcriptions",
        headers=AUTH,
        json={"audio_id": audio_id, "model": "qwen3-asr-1.7b", "language": "sw"},
    )
    assert response.status_code == 422
    assert "does not transcribe 'sw'" in response.json()["error"]["message"]


def test_a_failing_transcription_fails_the_job(client):
    audio_id = upload_audio(client, encode(tone(1))).json()["id"]
    job_id = client.post(
        "/api/v1/audio/transcriptions", headers=AUTH, json={"audio_id": audio_id, "prompt": "[mock:fail]"}
    ).json()["id"]
    job = wait(client, job_id)
    assert job["status"] == "failed" and job["error"]["code"] == "mock_failure"


def test_audio_uploads_expire_unless_a_job_needs_them(make_client):
    client = make_client()
    audio_id = upload_audio(client, encode(tone(1))).json()["id"]
    path = Path(client.app.state.audio.path(audio_id))
    old = time.time() - 10 * 24 * 3600
    os.utime(path.with_suffix(".json"), (old, old))
    client.app.state.cleanup_once()
    assert client.get(f"/api/v1/audio/uploads/{audio_id}", headers=AUTH).status_code == 404
    assert not path.exists()


def test_models_list_the_speech_models_and_limits(client):
    data = client.get("/api/v1/models", headers=AUTH).json()
    speech = [m["id"] for m in data["data"] if "speech-to-text" in m["tasks"]]
    assert speech == ["whisper-large-v3-turbo", "qwen3-asr-1.7b"]
    assert data["limits"]["max_audio_seconds"] == 4 * 3600


# -- the registry -------------------------------------------------------------


def test_speech_models_need_their_files():
    registry = load_registry()
    model = registry.get("qwen3-asr-1.7b")
    paths = [ref.path for ref in model.files_for(model.profile(None), "speech-to-text")]
    assert paths == ["speech/Qwen3-ASR-1.7B", "speech/Qwen3-ForcedAligner-0.6B"]


@pytest.mark.parametrize(
    "component",
    [
        {"format": "transformers", "subfolder": "x"},
        {
            "format": "transformers",
            "file": {"path": "speech/x", "repo": "a/b", "filename": "model.safetensors"},
        },
    ],
)
def test_a_transformers_component_is_the_base_or_a_directory(component):
    whisper = next(m for m in _default_model_data() if m["id"] == "whisper-large-v3-turbo")
    whisper["profiles"][0]["components"]["model"] = component
    with pytest.raises(ConfigError, match="transformers component"):
        load_registry(yaml.safe_load(yaml.safe_dump([whisper])), include_defaults=False)
