from __future__ import annotations

import io
import time
from collections.abc import Callable, Iterator
from pathlib import Path

import pytest
import yaml
from fastapi.testclient import TestClient
from PIL import Image

from media_api.app import create_app, memory_snapshot_for_tests
from media_api.config import load_settings
from media_api.registry import _default_model_data

API_KEY = "test-key-0123456789abcdefXYZ"
AUTH = {"Authorization": f"Bearer {API_KEY}"}


@pytest.fixture
def env(tmp_path: Path) -> dict[str, str]:
    return {
        "MEDIA_API_KEY": API_KEY,
        "MEDIA_BACKEND": "mock",
        "MEDIA_MODELS_DIR": str(tmp_path / "models"),
        "MEDIA_OUTPUT_DIR": str(tmp_path / "outputs"),
        "MEDIA_UPLOAD_DIR": str(tmp_path / "uploads"),
        "MEDIA_STATE_DIR": str(tmp_path / "state"),
        "MEDIA_MEMORY_CHECK": "off",
    }


# The built-in registry lists only profiles that run, so the unsupported path is
# exercised through MEDIA_CONFIG: qwen-image-2512 as shipped plus this profile.
UNSUPPORTED_PROFILE = {
    "id": "nf4-bitsandbytes",
    "label": "NF4 via bitsandbytes",
    "status": "unsupported",
    "reason": "bitsandbytes has no verified gfx1151 build for this image's ROCm torch.",
}


def unsupported_registry_models() -> list[dict]:
    qwen = next(m for m in _default_model_data() if m["id"] == "qwen-image-2512")
    qwen["profiles"].append(dict(UNSUPPORTED_PROFILE))
    return [qwen]


@pytest.fixture
def unsupported_config(env: dict[str, str], tmp_path: Path) -> dict[str, str]:
    path = tmp_path / "media.yaml"
    path.write_text(yaml.safe_dump({"models": unsupported_registry_models()}), encoding="utf-8")
    env["MEDIA_CONFIG"] = str(path)
    return env


@pytest.fixture
def make_client(env: dict[str, str]) -> Iterator[Callable[..., TestClient]]:
    clients: list[TestClient] = []

    def factory(memory_gb: float | None = None, **overrides: str) -> TestClient:
        settings = load_settings({**env, **overrides})
        probe = (
            memory_snapshot_for_tests(memory_gb) if memory_gb is not None else memory_snapshot_for_tests(None)
        )
        client = TestClient(create_app(settings, memory_probe=probe), base_url="http://testserver")
        client.__enter__()
        clients.append(client)
        return client

    yield factory
    for client in clients:
        client.__exit__(None, None, None)


@pytest.fixture
def client(make_client: Callable[..., TestClient]) -> TestClient:
    return make_client()


def png_bytes(
    size: tuple[int, int] = (64, 48), color: tuple[int, int, int] = (200, 30, 30), fmt: str = "PNG"
) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", size, color).save(buffer, format=fmt)
    return buffer.getvalue()


def upload(
    client: TestClient, data: bytes | None = None, content_type: str = "image/png", name: str = "in.png"
) -> dict:
    response = client.post(
        "/api/v1/uploads", headers=AUTH, files={"file": (name, data or png_bytes(), content_type)}
    )
    assert response.status_code == 201, response.text
    return response.json()


def wait(client: TestClient, job_id: str, timeout: float = 30.0, headers: dict | None = None) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        job = client.get(f"/api/v1/jobs/{job_id}", headers=headers if headers is not None else AUTH).json()
        if job["status"] in ("succeeded", "failed", "cancelled"):
            return job
        time.sleep(0.02)
    raise AssertionError(f"job {job_id} did not finish: {job}")
