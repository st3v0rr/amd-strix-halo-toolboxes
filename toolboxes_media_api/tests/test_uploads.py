from __future__ import annotations

import io
from concurrent.futures import ThreadPoolExecutor

import pytest
from PIL import Image

from media_api.storage import UploadStore

from .conftest import AUTH, png_bytes, upload


def test_upload_roundtrip_reencodes_to_png(client):
    info = upload(client, png_bytes(fmt="JPEG"), "image/jpeg", "../../etc/passwd.jpg")
    assert info["content_type"] == "image/png" and info["width"] == 64
    assert "/" not in info["filename"] and ".." not in info["filename"].replace(".jpg", "")
    body = client.get(info["url"], headers=AUTH)
    assert body.status_code == 200 and body.content.startswith(b"\x89PNG")
    assert client.get(info["url"]).status_code == 401


@pytest.mark.parametrize(
    ("data", "ctype", "status"),
    [
        (b"not an image at all", "image/png", 415),
        (png_bytes(), "image/jpeg", 415),  # declared type does not match the content
        (png_bytes(), "text/html", 415),
        (b"<svg xmlns='http://www.w3.org/2000/svg'/>", "image/svg+xml", 415),
        (png_bytes(fmt="GIF"), "image/gif", 415),
    ],
)
def test_bad_uploads_rejected(client, data, ctype, status):
    response = client.post("/api/v1/uploads", headers=AUTH, files={"file": ("x", data, ctype)})
    assert response.status_code == status, response.text


def test_upload_size_limit(make_client):
    client = make_client(MEDIA_MAX_UPLOAD_BYTES="2048")
    big = png_bytes((256, 256))
    big = big + b"\0" * max(0, 4096 - len(big))
    response = client.post("/api/v1/uploads", headers=AUTH, files={"file": ("big.png", big, "image/png")})
    assert response.status_code == 413


def test_decompression_bomb_rejected(make_client):
    client = make_client(MEDIA_MAX_UPLOAD_PIXELS="10000")
    response = client.post(
        "/api/v1/uploads", headers=AUTH, files={"file": ("big.png", png_bytes((200, 200)), "image/png")}
    )
    assert response.status_code == 413


def test_encoded_upload_cap(make_client):
    client = make_client(MEDIA_MAX_ENCODED_UPLOAD_BYTES="1024")
    buffer = io.BytesIO()
    Image.effect_noise((128, 128), 100).convert("RGB").save(buffer, format="JPEG", quality=25)
    response = client.post(
        "/api/v1/uploads", headers=AUTH, files={"file": ("noise.jpg", buffer.getvalue(), "image/jpeg")}
    )
    assert response.status_code == 413


def test_aggregate_upload_count_is_atomic(make_client):
    client = make_client(MEDIA_MAX_UPLOAD_COUNT="1")

    def send(_: int):
        return client.post(
            "/api/v1/uploads", headers=AUTH, files={"file": ("x.png", png_bytes(), "image/png")}
        )

    with ThreadPoolExecutor(max_workers=8) as pool:
        responses = list(pool.map(send, range(8)))
    assert [response.status_code for response in responses].count(201) == 1
    rejected = [response for response in responses if response.status_code != 201]
    assert all(response.status_code == 429 for response in rejected)
    assert all(response.json()["error"]["code"] == "upload_quota_exceeded" for response in rejected)


def test_total_upload_bytes_limit(make_client):
    data = png_bytes((128, 128))
    encoded_size = len(data)
    client = make_client(MEDIA_MAX_TOTAL_UPLOAD_BYTES=str(max(1024, encoded_size)))
    upload(client, data)
    responses = [
        client.post("/api/v1/uploads", headers=AUTH, files={"file": ("x.png", data, "image/png")})
        for _ in range(max(2, 1024 // encoded_size + 1))
    ]
    assert any(response.status_code == 429 for response in responses)


def test_minimum_free_disk_limit(make_client):
    client = make_client(MEDIA_MIN_FREE_DISK_BYTES=str(1024**4))
    response = client.post(
        "/api/v1/uploads", headers=AUTH, files={"file": ("x.png", png_bytes(), "image/png")}
    )
    assert response.status_code == 507 and response.json()["error"]["code"] == "insufficient_storage"


def test_upload_store_removes_orphans_on_startup(tmp_path):
    root = tmp_path / "uploads"
    root.mkdir()
    orphan = root / ("upl_" + "a" * 32 + ".png")
    orphan.write_bytes(b"orphan")
    temporary = root / ".tmp-interrupted.png"
    temporary.write_bytes(b"partial")
    UploadStore(root, 4096, 4096, 100_000, 10, 100_000, 0)
    assert not orphan.exists() and not temporary.exists()


def test_json_body_limit(client):
    response = client.post(
        "/api/v1/images/generations",
        headers=AUTH,
        content=b"{" + b" " * (2 * 1024 * 1024) + b"}",
    )
    assert response.status_code == 413


@pytest.mark.parametrize(
    "path",
    [
        "/api/v1/uploads/..%2F..%2Fetc%2Fpasswd",
        "/api/v1/uploads/upl_../../../etc/passwd",
        "/api/v1/uploads/%2e%2e%2fstate",
        "/api/v1/jobs/..%2F..%2Fstate%2Fjobs/result",
        "/api/v1/jobs/job_../../x/result",
        "/api/v1/jobs/job_00000000000000000000000000000000%2F..%2F..",
    ],
)
def test_path_traversal(client, path):
    response = client.get(path, headers=AUTH)
    assert response.status_code in (404, 405), (path, response.status_code)
    assert "root:" not in response.text


def test_unknown_upload_reference_is_rejected_before_queueing(client):
    body = {"prompt": "edit", "image_ids": ["upl_" + "a" * 32]}
    response = client.post("/api/v1/images/edits", headers=AUTH, json=body)
    assert response.status_code == 422 and response.json()["error"]["code"] == "unknown_upload"
    assert client.get("/api/v1/jobs", headers=AUTH).json()["data"] == []


def test_transparent_upload_is_flattened(client):
    buffer = io.BytesIO()
    Image.new("RGBA", (32, 32), (0, 0, 0, 0)).save(buffer, format="PNG")
    info = upload(client, buffer.getvalue())
    image = Image.open(io.BytesIO(client.get(info["url"], headers=AUTH).content))
    assert image.mode == "RGB" and image.getpixel((0, 0)) == (255, 255, 255)
