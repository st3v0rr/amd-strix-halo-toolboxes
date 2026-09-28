"""`media-api-models`: see what a profile needs, and fetch it on request.

    media-api-models check                       # every model/profile: present or missing
    media-api-models check --json                # the same as one JSON document
    media-api-models fetch qwen-image-2512       # the default profile's files
    media-api-models fetch minimax-h3 --profile turbo --task text-to-video
    media-api-models fetch qwen-image-2512 --json   # progress as JSON lines on stdout

Fetching is always explicit: this command, or MEDIA_ALLOW_DOWNLOADS=1 for
first use. Files land under MEDIA_MODELS_DIR at the paths the registry names,
from the pinned revisions. HF_TOKEN is read by huggingface_hub itself and never
printed. Neither command needs MEDIA_API_KEY: they read the registry and the
model tree, not the API.

The `--json` forms are what the web interface reads (webui/server/src/media/).
Their shape is versioned; change it only together with that side.
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import os
import shutil
import sys
import threading
from collections.abc import Callable
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .config import Settings
    from .registry import FileRef, ModelSpec, ProfileSpec

JSON_VERSION = 1
GIB = 1024**3
GUARD_INTERVAL_S = 1.0
Reporter = Callable[..., None]


def _silent(event: str, **fields: Any) -> None:
    pass


def _json_reporter(event: str, **fields: Any) -> None:
    print(json.dumps({"event": event, **fields}, ensure_ascii=False), flush=True)


def profile_refs(model: ModelSpec, profile: ProfileSpec, task: str | None = None) -> list[FileRef]:
    """What a profile needs on disk, for one task or all of them, each file once."""
    refs: dict[tuple[str, str | None], FileRef] = {}
    for t in [task] if task else list(profile.tasks):
        for ref in model.files_for(profile, t):
            key = (ref.path, ref.filename)
            refs[key] = refs[key].with_include(ref.include) if key in refs else ref
    return list(refs.values())


def _remote_bytes(api: Any, ref: FileRef, models_dir: Path) -> int | None:
    """Bytes still to come for one entry, from the Hub's file listing; None if unknown.

    Only an estimate for the progress bar and the free-space check, so any
    failure (offline, an older huggingface_hub) just means "unknown".
    """
    try:
        if ref.is_dir:
            target = models_dir / ref.path
            total = 0
            for item in api.list_repo_tree(ref.repo, revision=ref.revision, recursive=True):
                size = getattr(item, "size", None)
                path = str(getattr(item, "path", ""))
                if size is None or not any(fnmatch.fnmatchcase(path, p) for p in ref.include):
                    continue
                if not (target / path).is_file():
                    total += int(size)
            return total
        infos = api.get_paths_info(ref.repo, [ref.filename], revision=ref.revision)
        sizes = [getattr(info, "size", None) for info in infos]
        return int(sizes[0]) if sizes and sizes[0] is not None else None
    except Exception:
        return None


def space_needed(total: int, reserve: int) -> int:
    """Free bytes a download of `total` bytes needs before it may start.

    The files, the service's own free-disk reserve (MEDIA_MIN_FREE_DISK_BYTES),
    and headroom for what huggingface_hub writes beside them — partials, the
    staging copy before the move, the Xet chunk cache: 2 %, at least 1 GiB.
    """
    return total + reserve + max(GIB, total // 50)


def check_space(models_dir: Path, sizes: dict[str, int | None], reserve: int, *, allow_unknown: bool) -> None:
    """Refuse a download that cannot fit, or whose size is unknown and nothing would stop it."""
    unknown = sorted(path for path, size in sizes.items() if size is None)
    if unknown and not allow_unknown:
        raise RuntimeError(f"size unknown for {', '.join(unknown)}; refusing an unbounded download")
    total = sum(size for size in sizes.values() if size is not None)
    models_dir.mkdir(parents=True, exist_ok=True)
    free = shutil.disk_usage(models_dir).free
    needed = space_needed(total, reserve)
    if needed > free:
        raise RuntimeError(
            f"not enough space in {models_dir}: {needed} bytes needed "
            f"({total} files, {reserve} reserve, headroom), {free} free"
        )


class DiskGuard:
    """Ends a download once free space falls below the reserve.

    The bound for what the up-front check cannot see: sizes the Hub did not
    report, or something else filling the disk meanwhile. huggingface_hub
    cannot be interrupted from another thread, so `on_breach` has to stop the
    process itself; partial files stay behind for a resume.
    """

    def __init__(
        self,
        path: Path,
        reserve: int,
        on_breach: Callable[[int], None],
        interval: float = GUARD_INTERVAL_S,
        free: Callable[[Path], int] | None = None,
    ) -> None:
        self._path, self._reserve, self._on_breach, self._interval = path, reserve, on_breach, interval
        self._free = free or (lambda p: shutil.disk_usage(p).free)
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="disk-guard", daemon=True)

    def __enter__(self) -> DiskGuard:
        # Once before anything is downloaded; a reading that fails here fails the fetch.
        free = self._free(self._path)
        if free < self._reserve:
            raise RuntimeError(
                f"only {free} bytes free in {self._path}, below the {self._reserve}-byte reserve"
            )
        self._thread.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self._stop.set()
        self._thread.join(timeout=self._interval + 1)

    def _run(self) -> None:
        while not self._stop.wait(self._interval):
            try:
                free = self._free(self._path)
            except OSError:
                # If free space cannot be verified even once, continuing is an
                # unbounded download. Fail closed on the first failed reading.
                self._on_breach(-1)
                return
            if free < self._reserve:
                self._on_breach(free)
                return


def fetch_profile(
    settings: Settings,
    model: ModelSpec,
    profile: ProfileSpec,
    task: str | None = None,
    report: Reporter = _silent,
    *,
    allow_unknown_size: bool = False,
) -> list[str]:
    """Download what is missing, after checking it fits.

    `allow_unknown_size` only for a caller that runs a DiskGuard: the service's
    own first-use download (MEDIA_ALLOW_DOWNLOADS) has none and so refuses
    entries whose size the Hub does not report.
    """
    from huggingface_hub import HfApi, hf_hub_download, snapshot_download

    os.environ.pop("HF_HUB_OFFLINE", None)
    pending = [ref for ref in profile_refs(model, profile, task) if ref.missing(settings.models_dir)]
    for ref in pending:
        if not ref.repo:
            raise RuntimeError(f"{ref.path} is missing and has no download source; place it by hand")

    sizes: dict[str, int | None] = {}
    if pending:
        api = HfApi()
        sizes = {ref.path: _remote_bytes(api, ref, settings.models_dir) for ref in pending}
        known = [size for size in sizes.values() if size is not None]
        total = sum(known) if len(known) == len(pending) else None
        report(
            "plan",
            model=model.id,
            profile=profile.id,
            task=task,
            files=[
                {
                    "path": ref.path,
                    "repo": ref.repo,
                    "kind": "dir" if ref.is_dir else "file",
                    "bytes": sizes[ref.path],
                }
                for ref in pending
            ],
            total_bytes=total,
        )
        # Refuse up front rather than fill the disk halfway through a 60 GB set.
        check_space(
            settings.models_dir,
            sizes,
            settings.limits.min_free_disk_bytes,
            allow_unknown=allow_unknown_size,
        )

    fetched: list[str] = []
    for index, ref in enumerate(pending):
        report("file", path=ref.path, index=index, count=len(pending), bytes=sizes.get(ref.path))
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
        report("fetched", path=ref.path, index=index, count=len(pending))
    return fetched


def inventory(settings: Settings) -> dict[str, Any]:
    """Every model and profile with what is on disk — the `check --json` document."""
    models = []
    for model in settings.registry.models:
        profiles = []
        for profile in model.profiles:
            entry: dict[str, Any] = {
                "id": profile.id,
                "label": profile.label,
                "status": profile.status,
                "description": profile.description,
                "reason": profile.reason,
                "tasks": list(profile.tasks),
                "estimated_memory_gb": profile.estimated_memory_gb,
                "lora": profile.lora.file.path if profile.lora else None,
                "default": profile.id == model.default_profile,
            }
            if profile.usable:
                per_task = {t: model.missing_files(profile, t, settings.models_dir) for t in profile.tasks}
                missing = sorted({m for files in per_task.values() for m in files})
                entry["available"] = not missing
                entry["missing"] = missing
                entry["tasks_available"] = {t: not files for t, files in per_task.items()}
                entry["downloadable"] = all(
                    ref.repo for ref in profile_refs(model, profile) if ref.missing(settings.models_dir)
                )
            profiles.append(entry)
        models.append(
            {
                "id": model.id,
                "label": model.label,
                "provider": model.provider,
                "description": model.description,
                "license": model.license,
                "tasks": list(model.tasks),
                "default_profile": model.default_profile,
                "profiles": profiles,
            }
        )
    return {"version": JSON_VERSION, "models_dir": str(settings.models_dir), "models": models}


def _print_check(settings: Settings) -> None:
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
                f"{model.id}/{profile.id} [{profile.status}, ~{profile.estimated_memory_gb:.0f} GB]: {state}"
            )


def main(argv: list[str] | None = None) -> int:
    from .config import load_settings
    from .errors import ApiError, ConfigError

    parser = argparse.ArgumentParser(prog="media-api-models", description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    check = sub.add_parser("check", help="list every profile and what it is missing")
    check.add_argument("--json", action="store_true", help="one JSON document instead of text")
    fetch = sub.add_parser("fetch", help="download a profile's files (explicit, never implicit)")
    fetch.add_argument("model")
    fetch.add_argument("--profile")
    fetch.add_argument("--task")
    fetch.add_argument("--json", action="store_true", help="progress as JSON lines on stdout")
    args = parser.parse_args(argv)
    report: Reporter = _json_reporter if args.json else _silent

    def fail(message: str, status: int) -> int:
        if args.json:
            report("error", message=message)
        else:
            print(message, file=sys.stderr)
        return status

    try:
        settings = load_settings(require_secrets=False)
    except ConfigError as exc:
        return fail(f"configuration error: {exc}", 2)
    if args.command == "check":
        if args.json:
            print(json.dumps(inventory(settings), ensure_ascii=False))
        else:
            _print_check(settings)
        return 0
    try:
        model = settings.registry.get(args.model)
        profile = model.profile(args.profile)
        if not profile.usable:
            return fail(f"{model.id}/{profile.id} cannot be used: {profile.reason}", 1)
        if args.task and args.task not in profile.tasks:
            return fail(f"{model.id}/{profile.id} does not support {args.task}", 1)
    except ApiError as exc:
        return fail(exc.message, 1)
    reserve = settings.limits.min_free_disk_bytes

    def breach(free: int) -> None:
        state = "could not be read" if free < 0 else f"fell to {free} bytes"
        fail(f"free space in {settings.models_dir} {state}; the reserve is {reserve} bytes", 3)
        sys.stdout.flush()
        sys.stderr.flush()
        os._exit(3)

    try:
        settings.models_dir.mkdir(parents=True, exist_ok=True)
        # The guard is what makes an unknown size acceptable here.
        with DiskGuard(settings.models_dir, reserve, breach):
            fetched = fetch_profile(settings, model, profile, args.task, report, allow_unknown_size=True)
    except Exception as exc:
        if not args.json:
            raise
        return fail(f"{type(exc).__name__}: {exc}", 1)
    if args.json:
        report("done", fetched=fetched)
    else:
        for path in fetched:
            print(f"fetched {path}")
        print("done")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
