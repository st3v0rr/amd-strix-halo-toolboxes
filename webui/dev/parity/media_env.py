"""Feed environments the web interface builds to the media API's real config loader.

Reads a JSON list of {"env": {...}} cases on stdin and answers, per case, which
MEDIA_* names the service does not know, and what load_settings() made of the
rest (or the ConfigError it raised). Secrets are supplied as files, the way the
container gets them. Run by dev/parity/media.mjs.
"""

import dataclasses
import importlib
import json
import os
import sys
import tempfile
from pathlib import Path

# The service's own source tree, not an installed copy: that is what the
# image ships and what the web interface has to agree with.
sys.path.insert(0, os.environ["MEDIA_API_SRC"])
cfg = importlib.import_module("media_api.config")

KNOWN = (
    set(cfg._ENV.values())
    | {f"MEDIA_{name.upper()}" for name in cfg._LIMIT_BOUNDS}
    | {
        "MEDIA_API_KEY",
        "MEDIA_API_KEY_FILE",
        "MEDIA_SESSION_SECRET",
        "MEDIA_SESSION_SECRET_FILE",
        "MEDIA_CONFIG",
    }
)

answers = []
for case in json.load(sys.stdin):
    env = dict(case["env"])
    unknown = sorted(k for k in env if k.startswith("MEDIA_") and k not in KNOWN)
    with tempfile.TemporaryDirectory() as tmp:
        key, session = Path(tmp, "api-key"), Path(tmp, "session-secret")
        key.write_text("k" * 43 + "\n")
        session.write_text("s" * 43 + "\n")
        env["MEDIA_API_KEY_FILE"], env["MEDIA_SESSION_SECRET_FILE"] = str(key), str(session)
        try:
            s = cfg.load_settings(env)
        except cfg.ConfigError as exc:
            answers.append({"ok": False, "unknown": unknown, "error": str(exc)})
            continue
        answers.append(
            {
                "ok": True,
                "unknown": unknown,
                "settings": {
                    "backend": s.backend,
                    "host": s.host,
                    "port": s.port,
                    "models_dir": str(s.models_dir),
                    "output_dir": str(s.output_dir),
                    "upload_dir": str(s.upload_dir),
                    "state_dir": str(s.state_dir),
                    "allow_downloads": s.allow_downloads,
                    "memory_check": s.memory_check,
                    "memory_reserve_gb": s.memory_reserve_gb,
                    "disable_mmap": s.disable_mmap,
                    "cookie_secure": s.cookie_secure,
                    "allow_x_api_key": s.allow_x_api_key,
                    "cors_origins": list(s.cors_origins),
                    "session_ttl_seconds": s.session_ttl_seconds,
                    "log_level": s.log_level,
                    "limits": dataclasses.asdict(s.limits),
                },
            }
        )
print(json.dumps(answers))
