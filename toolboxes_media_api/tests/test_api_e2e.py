from __future__ import annotations

import io

import av
import pytest
from PIL import Image

from .conftest import AUTH, upload, wait


def result(client, job):
    response = client.get(job["result"]["url"], headers=AUTH)
    assert response.status_code == 200
    return response


def test_models_listing(client):
    data = client.get("/api/v1/models", headers=AUTH).json()
    assert data["backend"] == "mock"
    ids = {m["id"]: m for m in data["data"]}
    h3 = {p["id"]: p for p in ids["minimax-h3"]["profiles"]}
    assert (
        h3["comfy-pruned-int8-convrot"]["status"] == "unsupported"
        and "reason" in h3["comfy-pruned-int8-convrot"]
    )
    assert h3["turbo"]["tasks"] == ["text-to-video", "image-to-video", "start-end-to-video"]


def test_text_to_image_end_to_end_and_deterministic(client):
    body = {"prompt": "a red fox", "width": 320, "height": 256, "steps": 2, "seed": 42}
    job = wait(client, client.post("/api/v1/images/generations", headers=AUTH, json=body).json()["id"])
    assert job["status"] == "succeeded" and job["progress"] == 1.0 and job["params"]["seed"] == 42
    first = result(client, job)
    assert first.headers["content-type"] == "image/png" and Image.open(io.BytesIO(first.content)).size == (
        320,
        256,
    )
    again = wait(client, client.post("/api/v1/images/generations", headers=AUTH, json=body).json()["id"])
    assert result(client, again).content == first.content
    other = wait(
        client, client.post("/api/v1/images/generations", headers=AUTH, json={**body, "seed": 7}).json()["id"]
    )
    assert result(client, other).content != first.content
    download = client.get(job["result"]["url"] + "?download=1", headers=AUTH)
    assert download.headers["content-disposition"].startswith("attachment")


def test_random_seed_is_resolved_and_reported(client):
    job = client.post(
        "/api/v1/images/generations", headers=AUTH, json={"prompt": "x", "width": 256, "height": 256}
    ).json()
    assert isinstance(job["params"]["seed"], int) and job["params"]["steps"] == 20


def test_image_edit_end_to_end(client):
    ids = [upload(client)["id"], upload(client)["id"]]
    body = {
        "prompt": "make it blue",
        "image_ids": ids,
        "width": 256,
        "height": 256,
        "steps": 2,
        "output_format": "webp",
    }
    job = wait(client, client.post("/api/v1/images/edits", headers=AUTH, json=body).json()["id"])
    assert job["status"] == "succeeded" and job["result"]["content_type"] == "image/webp"
    assert result(client, job).content[:4] == b"RIFF"


@pytest.mark.parametrize(
    ("extra", "task"),
    [
        ({}, "text-to-video"),
        ({"start": True}, "image-to-video"),
        ({"start": True, "end": True}, "start-end-to-video"),
        ({"refs": 2}, "reference-to-video"),
    ],
)
def test_video_tasks_end_to_end(client, extra, task):
    body = {"prompt": "surf", "width": 320, "height": 256, "steps": 2, "duration_seconds": 5}
    if extra.get("start"):
        body["start_image_id"] = upload(client)["id"]
    if extra.get("end"):
        body["end_image_id"] = upload(client)["id"]
    if extra.get("refs"):
        body["reference_image_ids"] = [upload(client)["id"] for _ in range(extra["refs"])]
    job = wait(client, client.post("/api/v1/videos/generations", headers=AUTH, json=body).json()["id"])
    assert job["task"] == task and job["status"] == "succeeded", job
    assert job["params"]["num_frames"] == 124  # 5 s at 24 fps, snapped up to 17n+5
    info = job["result"]
    assert info["content_type"] == "video/mp4" and info["has_audio"] and info["frames"] == 124
    with av.open(io.BytesIO(result(client, job).content)) as container:
        kinds = {s.type for s in container.streams}
        assert kinds == {"video", "audio"}
        assert container.streams.video[0].codec_context.name in ("h264", "libx264", "mpeg4")


def test_video_without_audio_and_webm(client):
    body = {
        "prompt": "quiet",
        "width": 256,
        "height": 256,
        "steps": 1,
        "num_frames": 124,
        "audio": False,
        "output_format": "webm",
    }
    job = wait(client, client.post("/api/v1/videos/generations", headers=AUTH, json=body).json()["id"])
    assert job["status"] == "succeeded" and not job["result"]["has_audio"]
    with av.open(io.BytesIO(result(client, job).content)) as container:
        assert {s.type for s in container.streams} == {"video"}


@pytest.mark.parametrize(
    ("path", "body", "code"),
    [
        ("/api/v1/videos/generations", {"prompt": "x", "fps": 30}, "capability_unsupported"),
        ("/api/v1/videos/generations", {"prompt": "x", "guidance": 3.0}, "capability_unsupported"),
        ("/api/v1/videos/generations", {"prompt": "x", "negative_prompt": "blur"}, "capability_unsupported"),
        ("/api/v1/videos/generations", {"prompt": "x", "duration_seconds": 30}, "capability_unsupported"),
        (
            "/api/v1/videos/generations",
            {"prompt": "x", "width": 1000, "height": 768},
            "capability_unsupported",
        ),
        (
            "/api/v1/videos/generations",
            {"prompt": "x", "width": 2048, "height": 1024},
            "capability_unsupported",
        ),
        (
            "/api/v1/videos/generations",
            {"prompt": "x", "profile": "turbo", "reference_image_ids": ["upl_" + "a" * 32]},
            "capability_unsupported",
        ),
        ("/api/v1/videos/generations", {"prompt": "x", "profile": "gguf-q2"}, "capability_unsupported"),
        ("/api/v1/images/generations", {"prompt": "x", "model": "minimax-h3"}, "capability_unsupported"),
        (
            "/api/v1/images/generations",
            {"prompt": "x", "width": 1000, "height": 1000},
            "capability_unsupported",
        ),
        (
            "/api/v1/images/generations",
            {"prompt": "x", "profile": "nf4-bitsandbytes"},
            "capability_unsupported",
        ),
        ("/api/v1/images/generations", {"prompt": "x", "model": "nope"}, "unknown_model"),
        ("/api/v1/images/generations", {"prompt": "x", "profile": "nope"}, "unknown_profile"),
        ("/api/v1/images/generations", {"prompt": "x", "steps": 0}, "validation_error"),
        ("/api/v1/images/generations", {"prompt": "x", "seed": -1}, "validation_error"),
        ("/api/v1/images/generations", {"prompt": "x", "unknown": 1}, "validation_error"),
        ("/api/v1/images/generations", {"prompt": "x\u0000y"}, "invalid_request"),
        ("/api/v1/images/generations", {"prompt": ""}, "validation_error"),
        (
            "/api/v1/images/edits",
            {"prompt": "x", "image_ids": ["a", "b", "c", "d"]},
            "capability_unsupported",
        ),
    ],
)
def test_invalid_requests_never_queue(client, path, body, code):
    response = client.post(path, headers=AUTH, json=body)
    assert response.status_code in (400, 422), response.text
    assert response.json()["error"]["code"] == code
    assert client.get("/api/v1/jobs", headers=AUTH).json()["data"] == []


def test_results_need_auth_and_a_finished_job(client):
    job = wait(
        client,
        client.post(
            "/api/v1/images/generations",
            headers=AUTH,
            json={"prompt": "x", "width": 256, "height": 256, "steps": 1},
        ).json()["id"],
    )
    assert client.get(job["result"]["url"]).status_code == 401
    assert (
        client.get(
            job["result"]["url"], headers={"Authorization": "Bearer wrong-key-000000000000"}
        ).status_code
        == 401
    )
    assert client.get("/api/v1/jobs/job_" + "f" * 32 + "/result", headers=AUTH).status_code == 404


def test_real_backend_reports_missing_files(make_client):
    client = make_client(MEDIA_BACKEND="real")
    response = client.post("/api/v1/images/generations", headers=AUTH, json={"prompt": "x"})
    assert response.status_code == 503
    error = response.json()["error"]
    assert error["code"] == "model_files_missing"
    assert "diffusion_models/qwen_image_2512_fp8_e4m3fn.safetensors" in error["details"]["missing"]
    assert "media-api-models fetch" in error["details"]["hint"]
    listing = client.get("/api/v1/models", headers=AUTH).json()
    fp8 = listing["data"][0]["profiles"][0]
    assert fp8["available"] is False and fp8["missing"]
