"""API-key checks, browser sessions and CSRF.

- The API key is compared in constant time, as SHA-256 digests so the length
  of the presented value does not matter either. It is never logged, stored or
  echoed.
- A browser login exchanges the key for a random session id. The cookie holds
  that id plus an HMAC over it — no key, nothing derived from the key that
  could be turned back into it. Sessions live in memory, so logout and a
  restart end them for good.
- Cookie-authenticated requests that change state need the session's CSRF
  token in X-CSRF-Token, and a cross-origin Origin header is refused outright.
  Requests authenticated with the key itself carry no ambient credential and
  need neither.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import threading
import time
from collections import deque
from dataclasses import dataclass

SESSION_COOKIE = "media_session"
CSRF_HEADER = "x-csrf-token"


def _digest(value: str) -> bytes:
    return hashlib.sha256(value.encode("utf-8", "surrogateescape")).digest()


class KeyVerifier:
    def __init__(self, api_key: str) -> None:
        self._digest = _digest(api_key)

    def matches(self, presented: str | None) -> bool:
        if not presented:
            return False
        return hmac.compare_digest(_digest(presented), self._digest)


def bearer_token(authorization: str | None) -> str | None:
    if not authorization:
        return None
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer":
        return None
    return token.strip() or None


@dataclass
class Session:
    sid: str
    csrf: str
    expires_at: float


class SessionStore:
    def __init__(self, secret: bytes, ttl_seconds: int, max_sessions: int = 256) -> None:
        self._secret = secret
        self._ttl = ttl_seconds
        self._max = max_sessions
        self._sessions: dict[str, Session] = {}
        self._lock = threading.Lock()

    def _sign(self, sid: str) -> str:
        mac = hmac.new(self._secret, b"session:" + sid.encode(), hashlib.sha256).digest()
        return base64.urlsafe_b64encode(mac).decode().rstrip("=")

    def create(self) -> tuple[Session, str]:
        now = time.time()
        session = Session(secrets.token_urlsafe(32), secrets.token_urlsafe(32), now + self._ttl)
        with self._lock:
            self._purge(now)
            while len(self._sessions) >= self._max:
                oldest = min(self._sessions.values(), key=lambda s: s.expires_at)
                self._sessions.pop(oldest.sid, None)
            self._sessions[session.sid] = session
        return session, f"{session.sid}.{self._sign(session.sid)}"

    def lookup(self, cookie: str | None) -> Session | None:
        if not cookie or cookie.count(".") != 1 or len(cookie) > 200:
            return None
        sid, signature = cookie.split(".")
        if not hmac.compare_digest(signature.encode(), self._sign(sid).encode()):
            return None
        with self._lock:
            session = self._sessions.get(sid)
            if session is None:
                return None
            if session.expires_at <= time.time():
                self._sessions.pop(sid, None)
                return None
            return session

    def revoke(self, sid: str) -> None:
        with self._lock:
            self._sessions.pop(sid, None)

    def _purge(self, now: float) -> None:
        for sid in [s.sid for s in self._sessions.values() if s.expires_at <= now]:
            self._sessions.pop(sid, None)

    @property
    def ttl(self) -> int:
        return self._ttl


def csrf_ok(session: Session, presented: str | None) -> bool:
    if not presented:
        return False
    return hmac.compare_digest(presented.encode(), session.csrf.encode())


def same_origin(origin: str | None, host: str | None) -> bool:
    """True when no Origin was sent, or it names this server's own host.

    Host and port are compared, not the scheme: behind a TLS-terminating proxy
    the browser says https while the app sees http. A cross-site page cannot
    make the browser send another site's host as its Origin.
    """
    if origin is None:
        return True
    if not host:
        return False
    netloc = origin.split("://", 1)[-1].rstrip("/").lower()
    return netloc == host.strip().lower()


class FailureThrottle:
    """Counts failed authentications per client; too many in a window → 429."""

    def __init__(self, limit: int, window_seconds: int) -> None:
        self._limit = limit
        self._window = window_seconds
        self._failures: dict[str, deque[float]] = {}
        self._lock = threading.Lock()

    def _recent(self, client: str, now: float) -> deque[float]:
        entries = self._failures.setdefault(client, deque())
        while entries and entries[0] <= now - self._window:
            entries.popleft()
        return entries

    def blocked(self, client: str) -> bool:
        with self._lock:
            return len(self._recent(client, time.monotonic())) >= self._limit

    def fail(self, client: str) -> None:
        with self._lock:
            now = time.monotonic()
            self._recent(client, now).append(now)
            if len(self._failures) > 10_000:  # bounded memory under a spray of addresses
                self._failures = {k: v for k, v in self._failures.items() if v}

    def reset(self, client: str) -> None:
        with self._lock:
            self._failures.pop(client, None)
