"""Removing one profile's files from the model tree — and nothing else.

The registry decides what a profile owns: the same `FileRef`s a fetch writes
(`profile_refs`), matched file by file against what is on disk. Three rules
keep a removal from reaching further than that:

* A file another profile still uses stays. "Still uses" means that profile is
  complete for at least one of its tasks; a profile that is only partly on
  disk protects nothing, otherwise two profiles sharing a file (fp8 and
  Lightning share the transformer, the Qwen models their text encoder, every
  profile of a model its base directory) could never be removed at all.
* Nothing outside MEDIA_MODELS_DIR is touched. A path whose directory resolves
  outside the tree (a symlinked role directory, say) is skipped and reported;
  a symlink inside the tree is removed as a link, never followed.
* What huggingface_hub leaves behind for those files goes too: the
  `.cache/huggingface` bookkeeping and `.incomplete` partials of a snapshot
  directory, and a single file's leftovers in the fetch's `.stage` directory.
  The shared Xet chunk cache under HF_HOME belongs to no model and stays.

No torch here: the CLI and the tests run this without the GPU stack.
"""

from __future__ import annotations

import base64
import contextlib
import fnmatch
import hashlib
import os
import stat
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .registry import FileRef, ModelSpec, ProfileSpec, Registry

#: Where the fetch stages single files before moving them into place.
STAGE_DIR = ".stage"
#: huggingface_hub's bookkeeping below a `local_dir`.
HF_DOWNLOAD_DIR = PurePosixPath(".cache/huggingface/download")


@dataclass
class Removal:
    """What removing one profile deletes, keeps and cannot touch."""

    model: str
    profile: str
    files: list[str] = field(default_factory=list)
    partials: list[str] = field(default_factory=list)
    kept: dict[str, list[str]] = field(default_factory=dict)
    skipped: dict[str, str] = field(default_factory=dict)
    bytes: int = 0
    dirs: list[str] = field(default_factory=list)

    @property
    def empty(self) -> bool:
        return not self.files and not self.partials

    def to_json(self) -> dict[str, Any]:
        return {
            "model": self.model,
            "profile": self.profile,
            "files": self.files,
            "partials": self.partials,
            "kept": [{"path": path, "used_by": by} for path, by in sorted(self.kept.items())],
            "skipped": [{"path": path, "reason": why} for path, why in sorted(self.skipped.items())],
            "bytes": self.bytes,
        }


def _short_hash(name: str) -> str:
    # huggingface_hub names a partial after the hash of its metadata file's name.
    return base64.urlsafe_b64encode(hashlib.sha1(name.encode(), usedforsecurity=False).digest()).decode()


def covers(ref: FileRef, rel: str) -> bool:
    """Whether `rel` (relative to the models dir) is one of the files `ref` names."""
    if not ref.is_dir:
        return rel == ref.path
    prefix = ref.path.rstrip("/") + "/"
    return rel.startswith(prefix) and any(fnmatch.fnmatchcase(rel[len(prefix) :], p) for p in ref.include)


def _kept_profiles(
    registry: Registry, models_dir: Path, model: ModelSpec, profile: ProfileSpec
) -> list[tuple[str, list[FileRef]]]:
    from .cli import profile_refs

    kept = []
    for other in registry.models:
        for candidate in other.profiles:
            if (other.id, candidate.id) == (model.id, profile.id) or not candidate.usable:
                continue
            if any(not other.missing_files(candidate, t, models_dir) for t in candidate.tasks):
                kept.append((f"{other.id}/{candidate.id}", profile_refs(other, candidate)))
    return kept


class _Tree:
    """The models dir, with every path checked before it is touched."""

    def __init__(self, models_dir: Path) -> None:
        self.root = models_dir
        self.real = models_dir.resolve()

    def path(self, rel: str) -> Path | None:
        """The path for `rel` if its directory is inside the tree, else None."""
        pure = PurePosixPath(rel)
        if pure.is_absolute() or not pure.parts or any(p in ("", ".", "..") for p in pure.parts):
            return None
        path = self.root.joinpath(*pure.parts)
        try:
            parent = path.parent.resolve(strict=True)
        except OSError:
            return None
        if parent != self.real and self.real not in parent.parents:
            return None
        return parent / path.name

    def entry(self, rel: str) -> tuple[Path, os.stat_result] | None:
        """A non-directory entry (file or link) at `rel`, or None if there is none."""
        path = self.path(rel)
        if path is None:
            return None
        try:
            st = path.lstat()
        except OSError:
            return None
        return None if stat.S_ISDIR(st.st_mode) else (path, st)

    def walk(self, rel: str) -> Iterator[str]:
        """Every non-directory entry below `rel`, relative to the tree; links are not followed."""
        top = self.path(rel)
        if top is None or top.is_symlink() or not top.is_dir():
            return
        for dirpath, dirnames, filenames in os.walk(top, followlinks=False):
            base = Path(dirpath)
            names = list(filenames) + [d for d in dirnames if (base / d).is_symlink()]
            for name in names:
                yield (PurePosixPath(rel) / (base / name).relative_to(top).as_posix()).as_posix()


def _partial_name(rel_in_download: PurePosixPath, known: set[str]) -> str:
    """Which repo file a `.cache/huggingface/download` entry belongs to.

    `<name>.metadata` and `<name>.lock` say it; a partial is
    `<hash of "<name>.metadata">.<etag>.incomplete` and is matched against
    the names that could be meant. One that matches none keeps its own name,
    which only a wildcard pattern can then claim.
    """
    parent, name = rel_in_download.parent, rel_in_download.name
    for suffix in (".metadata", ".lock"):
        if name.endswith(suffix):
            return (parent / name[: -len(suffix)]).as_posix()
    if name.endswith(".incomplete"):
        digest = name.split(".", 1)[0]
        for candidate in known:
            path = PurePosixPath(candidate)
            if path.parent == parent and _short_hash(f"{path.name}.metadata") == digest:
                return candidate
    return rel_in_download.as_posix()


def _literal(pattern: str) -> bool:
    return not any(ch in pattern for ch in "*?[")


def plan_removal(registry: Registry, models_dir: Path, model: ModelSpec, profile: ProfileSpec) -> Removal:
    """Work out what removing `profile` deletes; touches nothing."""
    from .cli import profile_refs

    tree = _Tree(models_dir)
    result = Removal(model.id, profile.id)
    kept = _kept_profiles(registry, models_dir, model, profile)

    def users(rel: str) -> list[str]:
        return [name for name, refs in kept if any(covers(ref, rel) for ref in refs)]

    def take(rel: str, bucket: list[str]) -> None:
        if rel in result.files or rel in result.partials:
            return
        found = tree.entry(rel)
        if found is None:
            if tree.path(rel) is None and os.path.lexists(models_dir / rel):
                result.skipped[rel] = "outside the model tree"
            return
        bucket.append(rel)
        if stat.S_ISREG(found[1].st_mode):
            result.bytes += found[1].st_size

    refs = profile_refs(model, profile)
    for ref in refs:
        if not ref.is_dir:
            by = users(ref.path)
            if by:
                if tree.entry(ref.path):
                    result.kept[ref.path] = by
            else:
                take(ref.path, result.files)
                if ref.filename:
                    _stage_partials(tree, ref.filename, take, result)
            continue

        target = PurePosixPath(ref.path)
        top = tree.path(ref.path)
        if top is None and os.path.lexists(models_dir / ref.path):
            result.skipped[ref.path] = "outside the model tree"
            continue
        if top is not None and top.is_symlink():
            result.skipped[ref.path] = "a link; not followed"
            continue
        cache = (target / ".cache").as_posix()
        entries = list(tree.walk(ref.path))
        for rel in entries:
            if rel.startswith(cache + "/") or not covers(ref, rel):
                continue
            by = users(rel)
            if by:
                result.kept[rel] = by
            else:
                take(rel, result.files)

        # huggingface_hub's bookkeeping for this directory.
        shared = [r for _, refs_ in kept for r in refs_ if r.is_dir and r.path == ref.path]
        download = (target / HF_DOWNLOAD_DIR).as_posix()
        if not shared:
            # Nothing that stays downloads into this directory: all of it is ours.
            for rel in entries:
                if rel.startswith(cache + "/"):
                    take(rel, result.partials)
            result.dirs.append(ref.path)
            continue
        known = {
            PurePosixPath(rel).relative_to(target).as_posix()
            for rel in entries
            if not rel.startswith(cache + "/")
        }
        known |= {p for r in (ref, *shared) for p in r.include if _literal(p)}
        for rel in entries:
            if not rel.startswith(download + "/"):
                continue
            name = _partial_name(PurePosixPath(rel).relative_to(download), known)
            full = f"{ref.path}/{name}"
            if covers(ref, full) and not users(full):
                take(rel, result.partials)
        result.dirs.append(ref.path)

    for rel in result.files + result.partials:
        result.kept.pop(rel, None)
    return result


def _stage_partials(
    tree: _Tree, filename: str, take: Callable[[str, list[str]], None], result: Removal
) -> None:
    """A single file's leftovers in the fetch's staging directory."""
    name = PurePosixPath(filename)
    download = PurePosixPath(STAGE_DIR) / HF_DOWNLOAD_DIR
    take((PurePosixPath(STAGE_DIR) / name).as_posix(), result.partials)
    for suffix in (".metadata", ".lock"):
        take((download / f"{filename}{suffix}").as_posix(), result.partials)
    digest = _short_hash(f"{name.name}.metadata")
    folder = (download / name.parent).as_posix()
    for rel in tree.walk(folder):
        entry = PurePosixPath(rel)
        if (
            entry.parent.as_posix() == folder
            and entry.name.startswith(digest + ".")
            and entry.name.endswith(".incomplete")
        ):
            take(rel, result.partials)
    if STAGE_DIR not in result.dirs:
        result.dirs.append(STAGE_DIR)


def _prune(tree: _Tree, rel: str) -> None:
    """Remove empty directories below and including `rel`; never follows a link."""
    top = tree.path(rel)
    if top is None or top.is_symlink() or not top.is_dir():
        return
    for dirpath, dirnames, _ in os.walk(top, topdown=False, followlinks=False):
        for name in dirnames:
            child = Path(dirpath) / name
            if not child.is_symlink():
                with contextlib.suppress(OSError):
                    child.rmdir()  # only if empty
    with contextlib.suppress(OSError):
        top.rmdir()


def apply_removal(models_dir: Path, plan: Removal) -> Removal:
    """Delete what `plan` lists, checking each path again right before it goes."""
    tree = _Tree(models_dir)
    done = Removal(plan.model, plan.profile, kept=plan.kept, skipped=dict(plan.skipped))
    for bucket, out in ((plan.files, done.files), (plan.partials, done.partials)):
        for rel in bucket:
            found = tree.entry(rel)
            if found is None:
                continue
            path, st = found
            try:
                path.unlink()
            except OSError as exc:
                done.skipped[rel] = exc.strerror or type(exc).__name__
                continue
            out.append(rel)
            if stat.S_ISREG(st.st_mode):
                done.bytes += st.st_size
    for rel in plan.dirs:
        _prune(tree, rel)
    return done
