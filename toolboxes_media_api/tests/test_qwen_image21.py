"""Qwen-Image-2.1 through the API (mock backend): one model for both image
tasks, a Turbo profile with a fixed schedule, and transparency end to end."""

from __future__ import annotations

import copy
import io

import pytest
from PIL import Image

from media_api.errors import ConfigError
from media_api.providers.media import has_transparency, save_image
from media_api.registry import _default_model_data, load_registry

from .conftest import AUTH, upload, wait


def test_listed_with_both_tasks_and_a_fixed_turbo_schedule(client):
    models = {m["id"]: m for m in client.get("/api/v1/models", headers=AUTH).json()["data"]}
    q21 = models["qwen-image-2.1"]
    assert set(q21["tasks"]) == {"text-to-image", "image-edit"}
    profiles = {p["id"]: p for p in q21["profiles"]}
    assert profiles["turbo-8step"]["fixed_steps"] == 8
    assert profiles["lightning-4step"]["fixed_steps"] == 4
    assert "fixed_steps" not in profiles["bf16"]
    # The older models stay the defaults of their tasks.
    body = {"prompt": "x", "width": 256, "height": 256}
    job = client.post("/api/v1/images/generations", headers=AUTH, json=body)
    assert job.json()["model"] == "qwen-image-2512"


def test_text_to_image_and_edit_on_one_model(client):
    body = {"prompt": "a fox", "model": "qwen-image-2.1", "width": 256, "height": 256, "seed": 3}
    job = wait(client, client.post("/api/v1/images/generations", headers=AUTH, json=body).json()["id"])
    assert job["status"] == "succeeded" and job["params"]["steps"] == 40

    buffer = io.BytesIO()
    Image.new("RGBA", (64, 64), (0, 0, 0, 0)).save(buffer, format="PNG")
    ids = [upload(client, buffer.getvalue())["id"] for _ in range(3)]
    edit = {"prompt": "add a hat", "model": "qwen-image-2.1", "profile": "turbo-8step", "image_ids": ids}
    job = wait(client, client.post("/api/v1/images/edits", headers=AUTH, json=edit).json()["id"])
    assert job["status"] == "succeeded" and job["params"]["steps"] == 8


def test_turbo_refuses_another_step_count_before_queueing(client):
    body = {"prompt": "x", "model": "qwen-image-2.1", "profile": "turbo-8step", "width": 256, "height": 256}
    response = client.post("/api/v1/images/generations", headers=AUTH, json={**body, "steps": 20})
    assert response.status_code == 422 and "fixed schedule of 8 steps" in response.json()["error"]["message"]
    assert client.get("/api/v1/jobs", headers=AUTH).json()["data"] == []
    response = client.post("/api/v1/images/generations", headers=AUTH, json={**body, "steps": 8})
    assert response.status_code == 202


def test_size_must_fit_the_32_pixel_grid(client):
    body = {"prompt": "x", "model": "qwen-image-2.1", "width": 272, "height": 256}
    response = client.post("/api/v1/images/generations", headers=AUTH, json=body)
    assert response.status_code == 422


@pytest.mark.parametrize(
    "sigmas",
    [[1.0, 1.0, 0.5], [1.2, 0.5], [0.5, 0.0], ["a"]],
)
def test_sigmas_must_be_a_decreasing_schedule(sigmas):
    data = copy.deepcopy(_default_model_data())
    model = next(m for m in data if m["id"] == "qwen-image-2.1")
    model["profiles"][1]["sigmas"] = sigmas
    with pytest.raises(ConfigError, match="sigmas"):
        load_registry(data, include_defaults=False)


@pytest.mark.parametrize(("fmt", "alpha_kept"), [("png", True), ("webp", True), ("jpeg", False)])
def test_results_keep_transparency_where_the_format_can(tmp_path, fmt, alpha_kept):
    image = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
    image.putpixel((2, 2), (10, 200, 10, 255))
    path, _ = save_image(image, tmp_path, fmt)
    with Image.open(path) as saved:
        assert has_transparency(saved) is alpha_kept
        if not alpha_kept:
            # Composited over white, not black (JPEG blurs only the block around the dot).
            assert min(saved.convert("RGB").getpixel((24, 24))) >= 250


def test_opaque_results_stay_rgb(tmp_path):
    path, _ = save_image(Image.new("RGBA", (8, 8), (1, 2, 3, 255)), tmp_path, "png")
    with Image.open(path) as saved:
        assert saved.mode == "RGB"


@pytest.mark.parametrize(
    ("change", "message"), [({"sigmas": None}, "go together"), ({"scheduler": "default"}, "go together")]
)
def test_sigmas_and_the_fixed_sigma_scheduler_go_together(change, message):
    data = copy.deepcopy(_default_model_data())
    profile = next(m for m in data if m["id"] == "qwen-image-2.1")["profiles"][2]
    profile.update(change)
    with pytest.raises(ConfigError, match=message):
        load_registry(data, include_defaults=False)
