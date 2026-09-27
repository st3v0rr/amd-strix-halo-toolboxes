from __future__ import annotations

from pathlib import Path

import pytest

from media_api.config import derive_session_secret, load_settings
from media_api.errors import ConfigError

from .conftest import API_KEY


def test_fails_closed_without_key(env):
    env.pop("MEDIA_API_KEY")
    with pytest.raises(ConfigError, match="MEDIA_API_KEY is not set"):
        load_settings(env)


@pytest.mark.parametrize(
    "key", ["short", "replace-with-a-long-random-key", "has space in the middle xx", "changeme"]
)
def test_rejects_weak_or_placeholder_keys(env, key):
    env["MEDIA_API_KEY"] = key
    with pytest.raises(ConfigError):
        load_settings(env)


def test_key_from_file(env, tmp_path: Path):
    secret = tmp_path / "key"
    secret.write_text(API_KEY + "\n")
    env.pop("MEDIA_API_KEY")
    env["MEDIA_API_KEY_FILE"] = str(secret)
    assert load_settings(env).api_key == API_KEY


def test_secrets_never_in_repr(env):
    text = repr(load_settings(env))
    assert API_KEY not in text and "session_secret" not in text


def test_session_secret_derived_or_validated(env):
    derived = derive_session_secret(API_KEY, None)
    assert len(derived) == 32 and API_KEY.encode() not in derived
    with pytest.raises(ConfigError):
        derive_session_secret(API_KEY, "too-short")
    with pytest.raises(ConfigError):
        derive_session_secret(API_KEY, API_KEY + "x" * 20 if False else API_KEY)
    env["MEDIA_SESSION_SECRET"] = "s" * 40
    assert load_settings(env).session_secret != derived


def test_yaml_then_env_precedence(env, tmp_path: Path):
    cfg = tmp_path / "media.yaml"
    cfg.write_text("server:\n  port: 9001\n  backend: mock\nlimits:\n  max_queued_jobs: 3\n  max_steps: 50\n")
    env["MEDIA_CONFIG"] = str(cfg)
    env["MEDIA_MAX_STEPS"] = "40"
    settings = load_settings(env)
    assert settings.port == 9001 and settings.limits.max_queued_jobs == 3 and settings.limits.max_steps == 40
    env["MEDIA_PORT"] = "9002"
    assert load_settings(env).port == 9002


def test_upload_aggregate_limits_from_environment(env):
    settings = load_settings(
        {
            **env,
            "MEDIA_MAX_ENCODED_UPLOAD_BYTES": "4096",
            "MEDIA_MAX_UPLOAD_COUNT": "7",
            "MEDIA_MAX_TOTAL_UPLOAD_BYTES": "8192",
            "MEDIA_MIN_FREE_DISK_BYTES": "0",
        }
    )
    assert settings.limits.max_encoded_upload_bytes == 4096
    assert settings.limits.max_upload_count == 7
    assert settings.limits.max_total_upload_bytes == 8192
    assert settings.limits.min_free_disk_bytes == 0


@pytest.mark.parametrize(
    "yaml_text",
    [
        "security:\n  api_key: abcdefabcdefabcdef\n",
        "server:\n  unknown_setting: 1\n",
        "limits:\n  max_steps: 0\n",
        "security:\n  cors_origins: ['*']\n",
        "- not a mapping\n",
    ],
)
def test_bad_yaml_rejected(env, tmp_path: Path, yaml_text):
    cfg = tmp_path / "bad.yaml"
    cfg.write_text(yaml_text)
    env["MEDIA_CONFIG"] = str(cfg)
    with pytest.raises(ConfigError):
        load_settings(env)


def test_invalid_env_values(env):
    for name, value in [
        ("MEDIA_BACKEND", "gpu"),
        ("MEDIA_PORT", "70000"),
        ("MEDIA_ALLOW_DOWNLOADS", "maybe"),
    ]:
        with pytest.raises(ConfigError):
            load_settings({**env, name: value})
