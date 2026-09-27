"""`python -m media_api`: validate the configuration, then serve.

Configuration errors (no API key, a placeholder key, a bad YAML file) end the
process with status 2 before anything listens — the service fails closed.
"""

from __future__ import annotations

import logging
import os
import sys


def main() -> None:
    from .config import load_settings
    from .errors import ConfigError

    try:
        settings = load_settings()
    except ConfigError as exc:
        print(f"media-api: configuration error: {exc}", file=sys.stderr)
        raise SystemExit(2) from None
    logging.basicConfig(
        level=settings.log_level.upper(), format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )
    if not settings.allow_downloads:
        # Belt and braces: even a code path that forgot local_files_only
        # cannot reach the Hub.
        os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

    import uvicorn

    from .app import create_app

    app = create_app(settings)
    # One process, one worker: the job queue and the resident model live in it.
    uvicorn.run(
        app,
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level,
        workers=1,
        proxy_headers=False,
        server_header=False,
    )


if __name__ == "__main__":
    main()
