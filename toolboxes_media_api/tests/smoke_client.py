"""End-to-end smoke check against a running media API in mock mode.

Standard library only, so it runs on any host (CI runner, the box itself):

    MEDIA_API_KEY=... python3 tests/smoke_client.py http://127.0.0.1:8100
"""

from __future__ import annotations

import http.client
import json
import os
import re
import struct
import sys
import time
import urllib.parse
import uuid
import zlib

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8100"
KEY = os.environ["MEDIA_API_KEY"]
FAILURES: list[str] = []


def request(method, path, body=None, headers=None):
    url = urllib.parse.urlsplit(BASE)
    conn = http.client.HTTPConnection(url.hostname, url.port, timeout=60)
    conn.request(method, path, body=body, headers=headers or {})
    response = conn.getresponse()
    data = response.read()
    conn.close()
    return response.status, dict(response.getheaders()), data


def check(label, condition):
    print(f"  {'✓' if condition else '✗'} {label}")
    if not condition:
        FAILURES.append(label)


def png(width=64, height=48):
    raw = b"".join(b"\x00" + bytes([200, 40, 40]) * width for _ in range(height))

    def chunk(kind, data):
        return (
            struct.pack(">I", len(data))
            + kind
            + data
            + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
        )

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )


AUTH = {"Authorization": f"Bearer {KEY}"}


def api_json(method, path, payload=None, headers=None):
    body = json.dumps(payload).encode() if payload is not None else None
    merged = {**AUTH, "Content-Type": "application/json", **(headers or {})}
    status, _, data = request(method, path, body, merged)
    return status, json.loads(data or b"null")


def upload():
    boundary = uuid.uuid4().hex
    body = (
        (
            f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="in.png"\r\n'
            f"Content-Type: image/png\r\n\r\n"
        ).encode()
        + png()
        + f"\r\n--{boundary}--\r\n".encode()
    )
    headers = {**AUTH, "Content-Type": f"multipart/form-data; boundary={boundary}"}
    status, _, data = request("POST", "/api/v1/uploads", body, headers)
    check(f"upload accepted ({status})", status == 201)
    return json.loads(data)["id"]


def run_job(label, path, payload, magic):
    status, job = api_json("POST", path, payload)
    check(f"{label}: queued ({status})", status == 202)
    deadline = time.time() + 120
    while job.get("status") in ("queued", "running") and time.time() < deadline:
        time.sleep(0.2)
        _, job = api_json("GET", f"/api/v1/jobs/{job['id']}")
    check(f"{label}: succeeded ({job.get('status')}, {job.get('error')})", job.get("status") == "succeeded")
    if job.get("status") != "succeeded":
        return
    status, headers, data = request("GET", job["result"]["url"], headers=AUTH)
    check(f"{label}: result {headers.get('content-type')}, {len(data)} bytes", status == 200 and magic(data))
    status, _, _ = request("GET", job["result"]["url"])
    check(f"{label}: result refused without key ({status})", status == 401)


def main():
    for _ in range(120):
        try:
            status, _, data = request("GET", "/healthz")
            if status == 200:
                break
        except OSError:
            pass
        time.sleep(0.5)
    print(f"Smoke-Test gegen {BASE}")
    check("healthz is public and minimal", json.loads(data) == {"status": "ok"})
    check("models without key → 401", request("GET", "/api/v1/models")[0] == 401)
    check(
        "models with wrong key → 401",
        request("GET", "/api/v1/models", headers={"Authorization": "Bearer wrong-key-000000000"})[0] == 401,
    )
    status, models = api_json("GET", "/api/v1/models")
    check(
        f"models with key → {status}, backend {models.get('backend')}",
        status == 200 and models.get("backend") == "mock",
    )

    status, headers, _ = request("GET", "/ui/")
    check("playground redirects to login", status == 303 and headers.get("location") == "/ui/login")
    form = urllib.parse.urlencode({"api_key": KEY}).encode()
    status, headers, _ = request(
        "POST", "/ui/login", form, {"Content-Type": "application/x-www-form-urlencoded"}
    )
    cookie = headers.get("set-cookie", "")
    check(
        "login sets an HttpOnly, SameSite=strict cookie without the key",
        status == 303 and "HttpOnly" in cookie and "samesite=strict" in cookie.lower() and KEY not in cookie,
    )
    session = {"Cookie": cookie.split(";", 1)[0]}
    status, _, page = request("GET", "/ui/", headers=session)
    token = re.search(rb'name="csrf-token" content="([^"]+)"', page)
    check("playground served with CSRF token", status == 200 and token is not None)
    body = json.dumps({"prompt": "smoke", "width": 256, "height": 256, "steps": 1}).encode()
    status, _, _ = request(
        "POST", "/api/v1/images/generations", body, {**session, "Content-Type": "application/json"}
    )
    check(f"cookie POST without CSRF → {status}", status == 403)
    csrf = {
        **session,
        "Content-Type": "application/json",
        "X-CSRF-Token": token.group(1).decode() if token else "",
    }
    status, _, _ = request("POST", "/api/v1/images/generations", body, csrf)
    check(f"cookie POST with CSRF → {status}", status == 202)

    run_job(
        "image",
        "/api/v1/images/generations",
        {"prompt": "a lighthouse", "width": 320, "height": 256, "steps": 3, "seed": 1},
        lambda d: d.startswith(b"\x89PNG"),
    )
    run_job(
        "edit",
        "/api/v1/images/edits",
        {"prompt": "make it blue", "image_ids": [upload()], "width": 256, "height": 256, "steps": 2},
        lambda d: d.startswith(b"\x89PNG"),
    )
    run_job(
        "video",
        "/api/v1/videos/generations",
        {
            "prompt": "waves",
            "width": 256,
            "height": 256,
            "steps": 2,
            "duration_seconds": 5,
            "start_image_id": upload(),
        },
        lambda d: d[4:8] == b"ftyp",
    )
    status, error = api_json("POST", "/api/v1/videos/generations", {"prompt": "x", "fps": 30})
    check(f"capability error before queueing ({status}, {error['error']['code']})", status == 422)

    print(f"\n{'OK' if not FAILURES else 'FEHLER: ' + ', '.join(FAILURES)}")
    return 1 if FAILURES else 0


if __name__ == "__main__":
    raise SystemExit(main())
