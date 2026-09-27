"""Configuration: built-in defaults < optional YAML file (MEDIA_CONFIG) < environment.

Secrets come from the environment (or a file named there) only. A YAML file
that tries to carry one is rejected, so a config file can be committed or
shared without leaking the key.
"""

from __future__ import annotations

import hashlib
import hmac
import os
from collections.abc import Mapping
from dataclasses import dataclass, field, fields, replace
from pathlib import Path
from typing import Any, Literal

import yaml

from .errors import ConfigError
from .registry import Registry, load_registry

MIN_KEY_LENGTH = 16
MIN_SESSION_SECRET_LENGTH = 32
# Values from .env.example and the docs. Starting with one of these means the
# example was copied without choosing a key, which is exactly the mistake
# fail-closed startup is meant to catch.
PLACEHOLDER_KEYS = frozenset(
    {
        "replace-with-a-long-random-key",
        "replace-with-a-different-long-random-secret",
        "changeme",
        "change-me",
        "example-key",
        "secret",
        "password",
    }
)
SECRET_YAML_KEYS = frozenset({"api_key", "session_secret", "hf_token", "token"})


@dataclass(frozen=True)
class Limits:
    max_upload_bytes: int = 20 * 1024 * 1024
    max_encoded_upload_bytes: int = 40 * 1024 * 1024
    max_upload_pixels: int = 40_000_000
    max_upload_count: int = 1000
    max_total_upload_bytes: int = 2 * 1024 * 1024 * 1024
    min_free_disk_bytes: int = 1024 * 1024 * 1024
    max_queued_jobs: int = 16
    max_prompt_chars: int = 8000
    max_negative_prompt_chars: int = 2000
    max_width: int = 2048
    max_height: int = 2048
    max_pixels: int = 4_194_304
    max_frames: int = 345
    max_steps: int = 100
    max_edit_images: int = 3
    max_reference_images: int = 9
    result_ttl_hours: float = 72.0
    max_retained_jobs: int = 500
    login_attempts_per_window: int = 10
    login_window_seconds: int = 300


@dataclass(frozen=True)
class Settings:
    api_key: str = field(repr=False)
    session_secret: bytes = field(repr=False)
    backend: Literal["real", "mock"] = "real"
    host: str = "127.0.0.1"
    port: int = 8100
    models_dir: Path = Path("/models")
    output_dir: Path = Path("/data/outputs")
    upload_dir: Path = Path("/data/uploads")
    state_dir: Path = Path("/data/state")
    config_path: Path | None = None
    allow_downloads: bool = False
    device: str = "cuda"
    memory_check: Literal["strict", "warn", "off"] = "strict"
    memory_reserve_gb: float = 8.0
    disable_mmap: bool = True
    cookie_secure: bool = False
    session_ttl_seconds: int = 12 * 3600
    allow_x_api_key: bool = True
    cors_origins: tuple[str, ...] = ()
    mock_step_seconds: float = 0.0
    log_level: str = "info"
    limits: Limits = field(default_factory=Limits)
    registry: Registry = field(default_factory=Registry.empty, repr=False)

    def for_tests(self, **changes: Any) -> Settings:
        return replace(self, **changes)


_TRUE = {"1", "true", "yes", "on"}
_FALSE = {"0", "false", "no", "off", ""}


def _bool(value: Any, name: str) -> bool:
    if isinstance(value, bool):
        return value
    text = str(value).strip().lower()
    if text in _TRUE:
        return True
    if text in _FALSE:
        return False
    raise ConfigError(f"{name}: expected a boolean (1/0, true/false), got {value!r}")


def _number(value: Any, name: str, kind: type, low: float, high: float) -> Any:
    try:
        number = kind(value)
    except (TypeError, ValueError):
        raise ConfigError(f"{name}: expected {kind.__name__}, got {value!r}") from None
    if not low <= number <= high:
        raise ConfigError(f"{name}: {number} is outside {low}..{high}")
    return number


_LIMIT_BOUNDS: dict[str, tuple[type, float, float]] = {
    "max_upload_bytes": (int, 1024, 512 * 1024 * 1024),
    "max_encoded_upload_bytes": (int, 1024, 1024 * 1024 * 1024),
    "max_upload_pixels": (int, 1024, 400_000_000),
    "max_upload_count": (int, 1, 1_000_000),
    "max_total_upload_bytes": (int, 1024, 1024 * 1024 * 1024 * 1024),
    "min_free_disk_bytes": (int, 0, 1024 * 1024 * 1024 * 1024),
    "max_queued_jobs": (int, 1, 10_000),
    "max_prompt_chars": (int, 1, 100_000),
    "max_negative_prompt_chars": (int, 0, 100_000),
    "max_width": (int, 64, 8192),
    "max_height": (int, 64, 8192),
    "max_pixels": (int, 4096, 67_108_864),
    "max_frames": (int, 1, 2000),
    "max_steps": (int, 1, 1000),
    "max_edit_images": (int, 1, 16),
    "max_reference_images": (int, 1, 16),
    "result_ttl_hours": (float, 0.01, 24 * 365),
    "max_retained_jobs": (int, 1, 1_000_000),
    "login_attempts_per_window": (int, 1, 10_000),
    "login_window_seconds": (int, 1, 86_400),
}

# setting name -> (environment variable, parser)
_ENV = {
    "backend": "MEDIA_BACKEND",
    "host": "MEDIA_HOST",
    "port": "MEDIA_PORT",
    "models_dir": "MEDIA_MODELS_DIR",
    "output_dir": "MEDIA_OUTPUT_DIR",
    "upload_dir": "MEDIA_UPLOAD_DIR",
    "state_dir": "MEDIA_STATE_DIR",
    "allow_downloads": "MEDIA_ALLOW_DOWNLOADS",
    "device": "MEDIA_DEVICE",
    "memory_check": "MEDIA_MEMORY_CHECK",
    "memory_reserve_gb": "MEDIA_MEMORY_RESERVE_GB",
    "disable_mmap": "MEDIA_DISABLE_MMAP",
    "cookie_secure": "MEDIA_COOKIE_SECURE",
    "session_ttl_seconds": "MEDIA_SESSION_TTL_SECONDS",
    "allow_x_api_key": "MEDIA_ALLOW_X_API_KEY",
    "cors_origins": "MEDIA_CORS_ORIGINS",
    "mock_step_seconds": "MEDIA_MOCK_STEP_SECONDS",
    "log_level": "MEDIA_LOG_LEVEL",
}


def _coerce(name: str, value: Any) -> Any:
    label = _ENV.get(name, name)
    if name == "backend":
        if value not in ("real", "mock"):
            raise ConfigError(f"{label}: must be 'real' or 'mock', got {value!r}")
        return value
    if name == "memory_check":
        if value not in ("strict", "warn", "off"):
            raise ConfigError(f"{label}: must be strict, warn or off, got {value!r}")
        return value
    if name in {"models_dir", "output_dir", "upload_dir", "state_dir"}:
        path = Path(str(value)).expanduser()
        if not path.is_absolute():
            path = path.resolve()
        return path
    if name == "port":
        return _number(value, label, int, 1, 65535)
    if name == "memory_reserve_gb":
        return _number(value, label, float, 0, 1024)
    if name == "session_ttl_seconds":
        return _number(value, label, int, 60, 30 * 86_400)
    if name == "mock_step_seconds":
        return _number(value, label, float, 0, 10)
    if name in {"allow_downloads", "disable_mmap", "cookie_secure", "allow_x_api_key"}:
        return _bool(value, label)
    if name == "cors_origins":
        items = value if isinstance(value, list) else str(value).split(",")
        origins = tuple(o.strip().rstrip("/") for o in items if str(o).strip())
        for origin in origins:
            if origin == "*" or not origin.startswith(("http://", "https://")):
                raise ConfigError(f"{label}: list explicit http(s) origins; {origin!r} is not allowed")
        return origins
    if name == "log_level":
        level = str(value).lower()
        if level not in {"critical", "error", "warning", "info", "debug"}:
            raise ConfigError(f"{label}: unknown log level {value!r}")
        return level
    return str(value)


def _read_yaml(path: Path) -> dict[str, Any]:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise ConfigError(f"MEDIA_CONFIG={path}: cannot read ({exc.strerror})") from None
    try:
        data = yaml.safe_load(text) or {}
    except yaml.YAMLError as exc:
        raise ConfigError(f"MEDIA_CONFIG={path}: invalid YAML ({exc})") from None
    if not isinstance(data, dict):
        raise ConfigError(f"MEDIA_CONFIG={path}: the top level must be a mapping")
    _reject_secrets(data, path)
    return data


def _reject_secrets(node: Any, path: Path, trail: str = "") -> None:
    if isinstance(node, dict):
        for key, value in node.items():
            where = f"{trail}.{key}" if trail else str(key)
            if str(key).lower() in SECRET_YAML_KEYS:
                raise ConfigError(
                    f"MEDIA_CONFIG={path}: '{where}' looks like a secret. Secrets are read from the "
                    "environment only (MEDIA_API_KEY, MEDIA_SESSION_SECRET, HF_TOKEN)."
                )
            _reject_secrets(value, path, where)
    elif isinstance(node, list):
        for index, item in enumerate(node):
            _reject_secrets(item, path, f"{trail}[{index}]")


def _read_secret(env: Mapping[str, str], name: str) -> str | None:
    value = env.get(name)
    file_name = env.get(f"{name}_FILE")
    if value and file_name:
        raise ConfigError(f"Set either {name} or {name}_FILE, not both.")
    if file_name:
        try:
            value = Path(file_name).read_text(encoding="utf-8").strip()
        except OSError as exc:
            raise ConfigError(f"{name}_FILE={file_name}: cannot read ({exc.strerror})") from None
    return value or None


def validate_api_key(key: str | None) -> str:
    if not key:
        raise ConfigError(
            "MEDIA_API_KEY is not set. The service refuses to start without an API key; generate one "
            "with: python3 -c 'import secrets; print(secrets.token_urlsafe(32))'"
        )
    if key != key.strip() or any(ch.isspace() for ch in key):
        raise ConfigError("MEDIA_API_KEY must not contain whitespace.")
    if key.lower() in PLACEHOLDER_KEYS:
        raise ConfigError("MEDIA_API_KEY is still the example placeholder; choose a random key.")
    if len(key) < MIN_KEY_LENGTH:
        raise ConfigError(f"MEDIA_API_KEY is too short: use at least {MIN_KEY_LENGTH} characters.")
    return key


def derive_session_secret(api_key: str, explicit: str | None) -> bytes:
    if explicit is not None:
        if explicit.lower() in PLACEHOLDER_KEYS:
            raise ConfigError("MEDIA_SESSION_SECRET is still the example placeholder.")
        if len(explicit) < MIN_SESSION_SECRET_LENGTH:
            raise ConfigError(
                f"MEDIA_SESSION_SECRET is too short: use at least {MIN_SESSION_SECRET_LENGTH} characters."
            )
        if hmac.compare_digest(explicit.encode(), api_key.encode()):
            raise ConfigError("MEDIA_SESSION_SECRET must differ from MEDIA_API_KEY.")
        return hashlib.sha256(b"media-api/session/v1\x00" + explicit.encode()).digest()
    # Derived, one-way: a session cookie signed with this reveals nothing about
    # the key, and rotating the key invalidates every session with it.
    return hmac.new(api_key.encode(), b"media-api/session/v1", hashlib.sha256).digest()


def load_settings(env: Mapping[str, str] | None = None) -> Settings:
    env = os.environ if env is None else env
    raw_config = env.get("MEDIA_CONFIG") or None
    config_path = Path(raw_config).expanduser() if raw_config else None
    data = _read_yaml(config_path) if config_path else {}

    values: dict[str, Any] = {}
    for section in ("server", "paths", "security", "backend_options"):
        block = data.get(section) or {}
        if not isinstance(block, dict):
            raise ConfigError(f"MEDIA_CONFIG: '{section}' must be a mapping")
        for key, value in block.items():
            if key not in _ENV:
                raise ConfigError(f"MEDIA_CONFIG: unknown setting '{section}.{key}'")
            values[key] = _coerce(key, value)
    for name, variable in _ENV.items():
        if variable in env and env[variable] != "":
            values[name] = _coerce(name, env[variable])

    if values.get("backend") == "mock" and "memory_check" not in values:
        # The estimates describe real weights; the mock loads none.
        values["memory_check"] = "off"

    limit_values = dict((data.get("limits") or {}).items())
    for name in list(limit_values):
        if name not in _LIMIT_BOUNDS:
            raise ConfigError(f"MEDIA_CONFIG: unknown limit '{name}'")
    for name in _LIMIT_BOUNDS:
        variable = f"MEDIA_{name.upper()}"
        if env.get(variable):
            limit_values[name] = env[variable]
    limits = Limits(
        **{
            name: _number(value, f"limit {name}", *_LIMIT_BOUNDS[name])
            for name, value in limit_values.items()
        }
    )

    api_key = validate_api_key(_read_secret(env, "MEDIA_API_KEY"))
    session_secret = derive_session_secret(api_key, _read_secret(env, "MEDIA_SESSION_SECRET"))
    registry = load_registry(data.get("models"), include_defaults=data.get("include_default_models", True))

    known = {f.name for f in fields(Settings)}
    assert set(values) <= known
    return Settings(
        api_key=api_key,
        session_secret=session_secret,
        config_path=config_path,
        limits=limits,
        registry=registry,
        **values,
    )
