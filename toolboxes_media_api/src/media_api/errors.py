"""Structured errors.

Every error the API returns has the same shape::

    {"error": {"code": "...", "message": "...", "details": {...}}}

`code` is the stable, machine-readable part; `message` is for humans and may
change. Nothing here ever carries a credential: messages are written by this
code, never copied from a request header.
"""

from __future__ import annotations

from typing import Any


class ConfigError(RuntimeError):
    """The service cannot start with this configuration."""


class ApiError(Exception):
    status = 400
    code = "invalid_request"

    def __init__(
        self,
        message: str,
        *,
        code: str | None = None,
        status: int | None = None,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        if code is not None:
            self.code = code
        if status is not None:
            self.status = status
        self.details = details or {}

    def to_dict(self) -> dict[str, Any]:
        body: dict[str, Any] = {"code": self.code, "message": self.message}
        if self.details:
            body["details"] = self.details
        return {"error": body}


class Unauthorized(ApiError):
    status = 401
    code = "unauthorized"


class Forbidden(ApiError):
    status = 403
    code = "forbidden"


class NotFound(ApiError):
    status = 404
    code = "not_found"


class Conflict(ApiError):
    status = 409
    code = "conflict"


class PayloadTooLarge(ApiError):
    status = 413
    code = "payload_too_large"


class UnsupportedMediaType(ApiError):
    status = 415
    code = "unsupported_media_type"


class CapabilityError(ApiError):
    """The request is well-formed, but the selected model/profile cannot do it."""

    status = 422
    code = "capability_unsupported"


class TooManyRequests(ApiError):
    status = 429
    code = "rate_limited"


class ModelUnavailable(ApiError):
    """Files or configuration a profile needs are missing on this box."""

    status = 503
    code = "model_unavailable"


class JobCancelled(Exception):
    """Raised inside a running job once cancellation was requested."""


class ProviderError(Exception):
    """A generation failed in a way the client should learn about."""

    def __init__(self, code: str, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}
