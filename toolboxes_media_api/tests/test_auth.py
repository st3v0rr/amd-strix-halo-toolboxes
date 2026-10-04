from __future__ import annotations

import re

import pytest
from fastapi.routing import APIRoute

from .conftest import API_KEY, AUTH, png_bytes

PUBLIC = {
    ("GET", "/healthz"),
    ("GET", "/"),
    ("GET", "/ui/login"),
    ("POST", "/ui/login"),
    ("POST", "/ui/logout"),
    ("GET", "/ui/"),
}


def _login(client):
    response = client.post("/ui/login", data={"api_key": API_KEY}, follow_redirects=False)
    assert response.status_code == 303
    page = client.get("/ui/")
    return re.search(r'name="csrf-token" content="([^"]+)"', page.text).group(1)


def test_healthz_is_public_and_minimal(client):
    response = client.get("/healthz")
    assert response.status_code == 200 and response.json() == {"status": "ok"}


def test_every_non_public_route_requires_auth(client):
    routes = [r for r in client.app.routes if isinstance(r, APIRoute)]
    checked = 0
    for route in routes:
        for method in route.methods - {"HEAD"}:
            if (method, route.path) in PUBLIC:
                continue
            path = route.path.replace("{job_id}", "job_" + "0" * 32).replace("{upload_id}", "upl_" + "0" * 32)
            path = path.replace("{name}", "app.js")
            response = client.request(method, path)
            assert response.status_code == 401, (method, path, response.status_code)
            checked += 1
    assert checked >= 12


@pytest.mark.parametrize(
    "headers",
    [
        {},
        {"Authorization": "Bearer wrong-key-0123456789"},
        {"Authorization": f"Basic {API_KEY}"},
        {"X-API-Key": "nope"},
        {"Authorization": "Bearer "},
    ],
)
def test_missing_or_wrong_keys(client, headers):
    response = client.get("/api/v1/models", headers=headers)
    assert response.status_code == 401
    assert API_KEY not in response.text and "wrong-key" not in response.text
    assert response.json()["error"]["code"] == "unauthorized"


def test_bearer_and_x_api_key(client, make_client):
    assert client.get("/api/v1/models", headers=AUTH).status_code == 200
    assert client.get("/api/v1/models", headers={"X-API-Key": API_KEY}).status_code == 200
    strict = make_client(MEDIA_ALLOW_X_API_KEY="0")
    assert strict.get("/api/v1/models", headers={"X-API-Key": API_KEY}).status_code == 401


def test_openapi_is_protected_and_versioned(client):
    assert client.get("/openapi.json").status_code == 401
    spec = client.get("/openapi.json", headers=AUTH).json()
    for path in [
        "/api/v1/models",
        "/api/v1/images/generations",
        "/api/v1/images/edits",
        "/api/v1/videos/generations",
        "/api/v1/jobs/{job_id}",
        "/api/v1/jobs/{job_id}/cancel",
        "/api/v1/jobs/{job_id}/result",
    ]:
        assert path in spec["paths"]


def test_playground_requires_login(client):
    response = client.get("/ui/", follow_redirects=False)
    assert response.status_code == 303 and response.headers["location"] == "/ui/login"
    assert client.get("/ui/static/app.js").status_code == 401
    assert client.get("/ui/static/login.css").status_code == 200
    icon = client.get("/ui/static/favicon.svg")
    assert icon.status_code == 200 and icon.headers["content-type"].startswith("image/svg+xml")
    assert 'rel="icon"' in client.get("/ui/login").text


def test_login_wrong_key_sets_no_cookie(client):
    response = client.post("/ui/login", data={"api_key": "definitely-wrong-key"}, follow_redirects=False)
    assert response.status_code == 401 and "set-cookie" not in response.headers
    assert "definitely-wrong-key" not in response.text


def test_login_cookie_is_httponly_strict_and_keyless(client):
    response = client.post("/ui/login", data={"api_key": API_KEY}, follow_redirects=False)
    cookie = response.headers["set-cookie"]
    assert "HttpOnly" in cookie and "SameSite=strict" in cookie.replace("Strict", "strict")
    assert API_KEY not in cookie
    page = client.get("/ui/")
    assert page.status_code == 200 and 'name="csrf-token"' in page.text
    assert "script-src 'self'" in page.headers["content-security-policy"]
    assert client.get("/ui/static/app.js").status_code == 200


def test_cookie_requests_need_csrf(client):
    token = _login(client)
    body = {"prompt": "a cat", "width": 256, "height": 256, "steps": 1}
    assert client.get("/api/v1/models").status_code == 200  # safe method: cookie alone is enough
    missing = client.post("/api/v1/images/generations", json=body)
    assert missing.status_code == 403 and missing.json()["error"]["code"] == "csrf_failed"
    wrong = client.post("/api/v1/images/generations", json=body, headers={"X-CSRF-Token": "x" * 43})
    assert wrong.status_code == 403
    cross = client.post(
        "/api/v1/images/generations",
        json=body,
        headers={"X-CSRF-Token": token, "Origin": "https://evil.example"},
    )
    assert cross.status_code == 403
    ok = client.post(
        "/api/v1/images/generations",
        json=body,
        headers={"X-CSRF-Token": token, "Origin": "http://testserver"},
    )
    assert ok.status_code == 202
    files = {"file": ("a.png", png_bytes(), "image/png")}
    assert client.post("/api/v1/uploads", files=files).status_code == 403
    assert client.post("/api/v1/uploads", files=files, headers={"X-CSRF-Token": token}).status_code == 201


def test_logout_needs_csrf_and_kills_the_session(client):
    token = _login(client)
    assert client.post("/ui/logout", data={"csrf": "bad"}, follow_redirects=False).status_code == 403
    response = client.post("/ui/logout", data={"csrf": token}, follow_redirects=False)
    assert response.status_code == 303
    assert client.get("/api/v1/models").status_code == 401


def test_stolen_cookie_after_logout_is_dead(client):
    token = _login(client)
    cookie = client.cookies.get("media_session")
    client.post("/ui/logout", data={"csrf": token})
    client.cookies.clear()
    client.cookies.set("media_session", cookie)
    assert client.get("/api/v1/models").status_code == 401


def test_forged_or_tampered_cookie(client):
    client.cookies.set("media_session", "abc.def")
    assert client.get("/api/v1/models").status_code == 401
    client.cookies.clear()
    _login(client)
    sid, sig = client.cookies.get("media_session").split(".")
    client.cookies.clear()
    client.cookies.set("media_session", f"{sid}x.{sig}")
    assert client.get("/api/v1/models").status_code == 401


def test_lan_login_accepts_different_origin_when_api_key_is_valid(client):
    response = client.post(
        "/ui/login",
        data={"api_key": API_KEY},
        headers={"Origin": "http://10.7.7.25:5173", "Host": "10.7.7.74:8000"},
        follow_redirects=False,
    )
    assert response.status_code == 303
    assert response.headers["location"] == "/ui/"
    assert "media_session=" in response.headers["set-cookie"]


def test_lan_login_rejects_invalid_api_key(client):
    response = client.post(
        "/ui/login",
        data={"api_key": "definitely-wrong-key"},
        headers={"Origin": "http://10.7.7.25:5173", "Host": "10.7.7.74:8000"},
        follow_redirects=False,
    )
    assert response.status_code == 401
    assert "media_session=" not in response.headers.get("set-cookie", "")


def test_failed_attempts_are_throttled(make_client):
    client = make_client(MEDIA_LOGIN_ATTEMPTS_PER_WINDOW="3")
    for _ in range(3):
        assert (
            client.get("/api/v1/models", headers={"Authorization": "Bearer wrong-0123456789ab"}).status_code
            == 401
        )
    assert (
        client.get("/api/v1/models", headers={"Authorization": "Bearer wrong-0123456789ab"}).status_code
        == 429
    )
    assert client.get("/api/v1/models", headers=AUTH).status_code == 429  # blocked client, even with the key
    assert client.post("/ui/login", data={"api_key": API_KEY}).status_code == 429


def test_no_permissive_cors_by_default(client, make_client):
    response = client.options(
        "/api/v1/models", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "GET"}
    )
    assert "access-control-allow-origin" not in response.headers
    allowed = make_client(MEDIA_CORS_ORIGINS="https://app.example")
    response = allowed.options(
        "/api/v1/models", headers={"Origin": "https://app.example", "Access-Control-Request-Method": "GET"}
    )
    assert response.headers.get("access-control-allow-origin") == "https://app.example"
    assert "access-control-allow-credentials" not in response.headers


def test_same_origin_ignores_scheme_behind_tls_proxy(client):
    token = _login(client)
    body = {"prompt": "a cat", "width": 256, "height": 256, "steps": 1}
    proxied = {"X-CSRF-Token": token, "Origin": "https://testserver"}
    assert client.post("/api/v1/images/generations", json=body, headers=proxied).status_code == 202
    other_port = {"X-CSRF-Token": token, "Origin": "http://testserver:8080"}
    assert client.post("/api/v1/images/generations", json=body, headers=other_port).status_code == 403
