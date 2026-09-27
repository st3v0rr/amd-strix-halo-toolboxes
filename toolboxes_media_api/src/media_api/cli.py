"""`media-api-models`: see what a profile needs, and fetch it on request.

    media-api-models check                       # every model/profile: present or missing
    media-api-models fetch qwen-image-2512       # the default profile's files
    media-api-models fetch minimax-h3 --profile turbo --task text-to-video

Fetching is always explicit: this command, or MEDIA_ALLOW_DOWNLOADS=1 for
first use. Files land under MEDIA_MODELS_DIR at the paths the registry names,
from the pinned revisions. HF_TOKEN is read by huggingface_hub itself and never
printed.
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .config import Settings
    from .registry import FileRef, ModelSpec, ProfileSpec


def fetch_profile(
    settings: Settings, model: ModelSpec, profile: ProfileSpec, task: str | None = None
) -> list[str]:
    from huggingface_hub import hf_hub_download, snapshot_download

    os.environ.pop("HF_HUB_OFFLINE", None)
    fetched: list[str] = []
    tasks = [task] if task else list(profile.tasks)
    refs: dict[tuple[str, str | None], FileRef] = {}
    for t in tasks:
        for ref in model.files_for(profile, t):
            refs.setdefault((ref.path, ref.filename), ref)
            if ref.is_dir:  # merge the include patterns of every task
                refs[(ref.path, ref.filename)] = refs[(ref.path, ref.filename)].with_include(ref.include)
    for ref in refs.values():
        missing = ref.missing(settings.models_dir)
        if not missing:
            continue
        if not ref.repo:
            raise RuntimeError(f"{ref.path} is missing and has no download source; place it by hand")
        target = settings.models_dir / ref.path
        if ref.is_dir:
            snapshot_download(
                ref.repo, revision=ref.revision, local_dir=target, allow_patterns=list(ref.include)
            )
        else:
            stage = settings.models_dir / ".stage"
            downloaded = hf_hub_download(ref.repo, ref.filename, revision=ref.revision, local_dir=stage)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(downloaded, target)
        fetched.append(ref.path)
    return fetched


def main(argv: list[str] | None = None) -> int:
    from .config import load_settings
    from .errors import ApiError, ConfigError

    parser = argparse.ArgumentParser(prog="media-api-models", description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("check", help="list every profile and what it is missing")
    fetch = sub.add_parser("fetch", help="download a profile's files (explicit, never implicit)")
    fetch.add_argument("model")
    fetch.add_argument("--profile")
    fetch.add_argument("--task")
    args = parser.parse_args(argv)
    try:
        settings = load_settings()
    except ConfigError as exc:
        print(f"configuration error: {exc}", file=sys.stderr)
        return 2
    if args.command == "check":
        for model in settings.registry.models:
            for profile in model.profiles:
                if not profile.usable:
                    print(f"{model.id}/{profile.id}: unsupported — {profile.reason}")
                    continue
                missing = sorted(
                    {m for t in profile.tasks for m in model.missing_files(profile, t, settings.models_dir)}
                )
                state = "ready" if not missing else "missing " + ", ".join(missing)
                print(
                    f"{model.id}/{profile.id} [{profile.status}, "
                    f"~{profile.estimated_memory_gb:.0f} GB]: {state}"
                )
        return 0
    try:
        model = settings.registry.get(args.model)
        profile = model.profile(args.profile)
        if not profile.usable:
            print(f"{model.id}/{profile.id} cannot be used: {profile.reason}", file=sys.stderr)
            return 1
        if args.task and args.task not in profile.tasks:
            print(f"{model.id}/{profile.id} does not support {args.task}", file=sys.stderr)
            return 1
    except ApiError as exc:
        print(exc.message, file=sys.stderr)
        return 1
    for path in fetch_profile(settings, model, profile, args.task):
        print(f"fetched {path}")
    print("done")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
