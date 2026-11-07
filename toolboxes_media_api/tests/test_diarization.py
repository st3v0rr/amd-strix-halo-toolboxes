"""Speaker diarization: turns from activity, speakers on segments and words,
the API switch, and the files it needs. The mock diarizer gives each stretch
of sound between pauses of a second or more to the next of two speakers."""

from __future__ import annotations

import numpy as np

from media_api.config import load_settings
from media_api.speech import (
    Segment,
    Turn,
    TurnIndex,
    Word,
    assign_speakers,
    render,
    transcript_document,
    turns_from_activity,
)

from .conftest import AUTH
from .test_speech import encode, silence, tone, upload_audio, wait


def activity(spans: list[tuple[float, float, int]], seconds: float, speakers: int = 2) -> np.ndarray:
    probs = np.zeros((int(seconds * 100), speakers), dtype=np.float32)
    for start, end, speaker in spans:
        probs[int(start * 100) : int(end * 100), speaker] = 0.9
    return probs


def test_turns_close_short_pauses_and_drop_blips():
    probs = activity([(0.0, 2.0, 0), (2.2, 4.0, 0), (5.0, 5.1, 0), (3.5, 6.0, 1)], 8)
    turns = turns_from_activity(probs, 0.01)
    assert [(t.speaker, t.start, t.end) for t in turns] == [(0, 0.0, 4.0), (1, 3.5, 6.0)]  # overlap kept


def test_speaker_at_prefers_overlap_then_the_nearest_turn_within_reach():
    index = TurnIndex([Turn(0.0, 3.0, 0), Turn(3.0, 9.0, 1), Turn(30.0, 31.0, 0)])
    assert index.speaker_at(2.0, 5.0) == 1  # 2 s of speaker 1 beat 1 s of speaker 0
    assert index.speaker_at(9.3, 9.6) == 1  # a word just after a turn ends
    assert index.speaker_at(15.0, 16.0) is None  # nobody near
    assert TurnIndex([]).speaker_at(0.0, 1.0) is None


def test_segments_and_words_get_speakers_in_order_of_appearance():
    # The diarizer numbers speaker 3 first here; labels follow the transcript.
    turns = [Turn(0.0, 4.0, 3), Turn(4.0, 8.0, 0), Turn(8.0, 12.0, 3)]
    plain = [Segment(0.5, 3.5, "Hallo."), Segment(4.2, 7.9, "Hi."), Segment(8.1, 11.0, "Also.")]
    assert assign_speakers(plain, turns) == ["S1", "S2"]
    assert [s.speaker for s in plain] == ["S1", "S2", "S1"]

    words = [Word(0.2, 0.6, "ja"), Word(3.8, 4.6, "genau"), Word(4.7, 7.5, "so")]
    mixed = Segment(0.2, 7.5, "Ja genau so.", words)
    assign_speakers([mixed], turns)
    # Most of the segment's word time is speaker 0's; each word keeps its own.
    assert mixed.speaker == "S1" and [w.speaker for w in words] == ["S2", "S1", "S1"]


def test_documents_and_formats_carry_speakers_only_when_diarized():
    segments = [
        Segment(0.0, 1.0, "Hallo.", [Word(0.0, 1.0, "Hallo", "S1")], "S1"),
        Segment(1.5, 2.0, "Hi.", [], "S2"),
    ]
    doc = transcript_document(
        segments, model="m", profile="p", language="de", duration=2.0, words=True, speakers=["S1", "S2"]
    )
    assert doc["speakers"] == ["S1", "S2"] and doc["segments"][1]["speaker"] == "S2"
    assert doc["words"][0]["speaker"] == "S1"
    assert render(doc, "txt") == "[S1] Hallo.\n[S2] Hi.\n"
    assert "[S2] Hi." in render(doc, "srt") and "<v S1>Hallo." in render(doc, "vtt")
    plain = transcript_document(segments, model="m", profile="p", language="de", duration=2.0, words=True)
    assert (
        "speakers" not in plain
        and "speaker" not in plain["segments"][0]
        and "speaker" not in plain["words"][0]
    )
    assert render(plain, "txt") == "Hallo.\nHi.\n"


def test_diarized_transcription_end_to_end(client):
    # Three stretches of sound, pauses between them: S1, S2, then S1 again.
    recording = np.concatenate([tone(6), silence(2), tone(5, 660), silence(2), tone(4)])
    audio_id = upload_audio(client, encode(recording)).json()["id"]
    body = {
        "audio_id": audio_id,
        "model": "qwen3-asr-1.7b",
        "language": "de",
        "timestamps": "word",
        "diarize": True,
    }
    job = wait(client, client.post("/api/v1/audio/transcriptions", headers=AUTH, json=body).json()["id"])
    assert job["status"] == "succeeded", job
    assert job["params"]["diarize"] is True and job["result"]["speakers"] == 2
    doc = client.get(job["result"]["url"], headers=AUTH).json()
    assert doc["speakers"] == ["S1", "S2"]
    speaker_by_second = {int(w["start"]): w["speaker"] for w in doc["words"]}
    assert speaker_by_second[1] == "S1" and speaker_by_second[9] == "S2" and speaker_by_second[16] == "S1"

    txt = {**body, "output_format": "txt"}
    job = wait(client, client.post("/api/v1/audio/transcriptions", headers=AUTH, json=txt).json()["id"])
    assert client.get(job["result"]["url"], headers=AUTH).text.startswith("[S1] ")

    off = {**body, "diarize": False}
    job = wait(client, client.post("/api/v1/audio/transcriptions", headers=AUTH, json=off).json()["id"])
    doc = client.get(job["result"]["url"], headers=AUTH).json()
    assert "speakers" not in doc and "speakers" not in job["result"]


def test_the_diarizer_needs_its_files_before_queueing(make_client, env):
    # Real backend, Whisper's files present, the diarizer's not: refused up front.
    settings = load_settings(env)
    models_dir = settings.models_dir
    whisper = settings.registry.get("whisper-large-v3-turbo")
    for ref in whisper.files_for(whisper.profile(None), "speech-to-text"):
        for name in [*ref.include] or [ref.path]:
            target = models_dir / ref.path / name if ref.include else models_dir / ref.path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(b"{}")
    client = make_client(MEDIA_BACKEND="real")
    audio_id = upload_audio(client, encode(tone(3))).json()["id"]
    body = {"audio_id": audio_id, "language": "de"}
    response = client.post("/api/v1/audio/transcriptions", headers=AUTH, json={**body, "diarize": True})
    assert response.status_code == 503, response.text
    error = response.json()["error"]
    assert error["code"] == "model_files_missing" and error["details"]["model"] == "nemotron-3-diarization"
    assert client.post("/api/v1/audio/transcriptions", headers=AUTH, json=body).status_code == 202


def test_diarization_is_listed_but_has_no_endpoint(client):
    models = {m["id"]: m for m in client.get("/api/v1/models", headers=AUTH).json()["data"]}
    assert models["nemotron-3-diarization"]["tasks"] == ["speaker-diarization"]
    assert client.post("/api/v1/audio/diarizations", headers=AUTH, json={}).status_code in (404, 405)
