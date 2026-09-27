"""Uploads, outputs and the paths they live under.

No client-supplied string ever becomes part of a path: ids are generated here
and checked against a strict pattern before use, original filenames are kept
only as sanitized metadata, and every resolved path is confirmed to sit inside
its base directory.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import re
import secrets
import shutil
import tempfile
import threading
import time
import unicodedata
import warnings
from collections.abc import Iterable
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from PIL import Image

from .errors import ApiError, NotFound, PayloadTooLarge, UnsupportedMediaType

JOB_ID_RE = re.compile(r"^job_[0-9a-f]{32}$")
UPLOAD_ID_RE = re.compile(r"^upl_[0-9a-f]{32}$")
ALLOWED_UPLOAD_TYPES = {"image/png": "PNG", "image/jpeg": "JPEG", "image/webp": "WEBP"}


def new_job_id() -> str:
    return f"job_{secrets.token_hex(16)}"


def new_upload_id() -> str:
    return f"upl_{secrets.token_hex(16)}"


def check_job_id(job_id: str) -> str:
    if not JOB_ID_RE.match(job_id):
        raise NotFound("Job not found.")
    return job_id


def check_upload_id(upload_id: str) -> str:
    if not UPLOAD_ID_RE.match(upload_id):
        raise NotFound(f"Upload '{upload_id[:64]}' not found.")
    return upload_id


def confined(base: Path, *parts: str) -> Path:
    """Join and make sure the result is still inside `base` (defense in depth)."""
    root = base.resolve()
    path = root.joinpath(*parts).resolve()
    if path != root and root not in path.parents:
        raise NotFound("Not found.")
    return path


def sanitize_filename(name: str | None, fallback: str = "upload") -> str:
    name = unicodedata.normalize("NFKC", name or "")
    name = name.replace("\\", "/").rsplit("/", 1)[-1]
    name = re.sub(r"[^A-Za-z0-9._ -]", "_", name).strip(" .")
    return (name or fallback)[:100]


def atomic_write_bytes(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".tmp-", suffix=path.suffix)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def atomic_write_json(path: Path, payload: Any) -> None:
    atomic_write_bytes(path, json.dumps(payload, ensure_ascii=False, indent=1).encode("utf-8"))


@dataclass(frozen=True)
class UploadInfo:
    id: str
    filename: str
    content_type: str
    width: int
    height: int
    bytes: int
    sha256: str
    created_at: float

    def public(self) -> dict[str, Any]:
        data = asdict(self)
        data["url"] = f"/api/v1/uploads/{self.id}"
        return data


class UploadStore:
    """Validated input images. Stored re-encoded as PNG: whatever the client
    sent (EXIF, trailing data, polyglots) never reaches disk or a model."""

    def __init__(
        self,
        root: Path,
        max_bytes: int,
        max_encoded_bytes: int,
        max_pixels: int,
        max_count: int,
        max_total_bytes: int,
        min_free_disk_bytes: int,
    ) -> None:
        self.root = root
        self.max_bytes = max_bytes
        self.max_encoded_bytes = max_encoded_bytes
        self.max_pixels = max_pixels
        self.max_count = max_count
        self.max_total_bytes = max_total_bytes
        self.min_free_disk_bytes = min_free_disk_bytes
        self._lock = threading.RLock()
        root.mkdir(parents=True, exist_ok=True)
        self._count = 0
        self._total_bytes = 0
        self._reconcile()

    def save(self, data: bytes, declared_type: str | None, filename: str | None) -> UploadInfo:
        if len(data) > self.max_bytes:
            raise PayloadTooLarge(f"Upload exceeds {self.max_bytes} bytes.")
        declared = (declared_type or "").split(";")[0].strip().lower()
        expected_format = ALLOWED_UPLOAD_TYPES.get(declared)
        if expected_format is None:
            raise UnsupportedMediaType(
                "Only PNG, JPEG and WebP images can be uploaded.",
                details={"allowed": sorted(ALLOWED_UPLOAD_TYPES)},
            )
        image = self._decode(data, expected_format)
        width, height = image.size
        buffer = _CappedBuffer(self.max_encoded_bytes)
        image.save(buffer, format="PNG", optimize=False)
        png = buffer.getvalue()
        upload_id = new_upload_id()
        info = UploadInfo(
            id=upload_id,
            filename=sanitize_filename(filename),
            content_type="image/png",
            width=width,
            height=height,
            bytes=len(png),
            sha256=hashlib.sha256(png).hexdigest(),
            created_at=time.time(),
        )
        image_path = self.root / f"{upload_id}.png"
        meta_path = self.root / f"{upload_id}.json"
        with self._lock:
            if self._count >= self.max_count or self._total_bytes + len(png) > self.max_total_bytes:
                raise ApiError(
                    "Upload storage quota is full; wait for older uploads to expire.",
                    code="upload_quota_exceeded",
                    status=429,
                )
            free = shutil.disk_usage(self.root).free
            if free - len(png) < self.min_free_disk_bytes:
                raise ApiError(
                    "Not enough free disk space to store this upload.",
                    code="insufficient_storage",
                    status=507,
                )
            try:
                atomic_write_bytes(image_path, png)
                atomic_write_json(meta_path, asdict(info))
            except BaseException:
                image_path.unlink(missing_ok=True)
                meta_path.unlink(missing_ok=True)
                raise
            self._count += 1
            self._total_bytes += len(png)
        return info

    def _reconcile(self) -> None:
        """Remove incomplete upload pairs and reconstruct aggregate accounting."""
        with self._lock:
            valid: set[str] = set()
            total = 0
            for meta in self.root.glob("upl_*.json"):
                upload_id = meta.stem
                image = self.root / f"{upload_id}.png"
                try:
                    if not UPLOAD_ID_RE.match(upload_id):
                        raise ValueError("invalid upload id")
                    info = UploadInfo(**json.loads(meta.read_text(encoding="utf-8")))
                    if info.id != upload_id or not image.is_file() or image.stat().st_size != info.bytes:
                        raise ValueError("inconsistent upload record")
                except (OSError, TypeError, ValueError, KeyError):
                    meta.unlink(missing_ok=True)
                    image.unlink(missing_ok=True)
                    continue
                valid.add(upload_id)
                total += info.bytes
            for image in self.root.glob("upl_*.png"):
                if image.stem not in valid:
                    image.unlink(missing_ok=True)
            for temporary in self.root.glob(".tmp-*"):
                temporary.unlink(missing_ok=True)
            self._count = len(valid)
            self._total_bytes = total

    def _decode(self, data: bytes, expected_format: str) -> Image.Image:
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("error", Image.DecompressionBombWarning)
                probe = Image.open(io.BytesIO(data))
                if probe.format != expected_format:
                    raise UnsupportedMediaType(
                        f"The file content is {probe.format or 'not an image'}, not the declared "
                        f"{expected_format}."
                    )
                if probe.width * probe.height > self.max_pixels:
                    raise PayloadTooLarge(f"Image exceeds {self.max_pixels} pixels.")
                if getattr(probe, "n_frames", 1) > 1:
                    raise UnsupportedMediaType("Animated images are not accepted.")
                probe.load()
        except ApiError:
            raise
        except (Image.DecompressionBombError, Image.DecompressionBombWarning):
            raise PayloadTooLarge(f"Image exceeds {self.max_pixels} pixels.") from None
        except Exception:
            raise UnsupportedMediaType("The file is not a readable PNG, JPEG or WebP image.") from None
        if probe.mode in ("RGBA", "LA") or (probe.mode == "P" and "transparency" in probe.info):
            rgba = probe.convert("RGBA")
            background = Image.new("RGB", rgba.size, (255, 255, 255))
            background.paste(rgba, mask=rgba.getchannel("A"))
            return background
        return probe.convert("RGB")

    def get(self, upload_id: str) -> UploadInfo:
        check_upload_id(upload_id)
        meta = confined(self.root, f"{upload_id}.json")
        try:
            data = json.loads(meta.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            raise NotFound(f"Upload '{upload_id}' not found.") from None
        try:
            info = UploadInfo(**data)
        except (TypeError, ValueError):
            raise NotFound(f"Upload '{upload_id}' not found.") from None
        if info.id != upload_id:
            raise NotFound(f"Upload '{upload_id}' not found.")
        return info

    def path(self, upload_id: str) -> Path:
        self.get(upload_id)
        path = confined(self.root, f"{upload_id}.png")
        if not path.is_file():
            raise NotFound(f"Upload '{upload_id}' not found.")
        return path

    def cleanup(self, max_age_seconds: float, keep: Iterable[str]) -> int:
        keep_set = set(keep)
        cutoff = time.time() - max_age_seconds
        removed = 0
        with self._lock:
            for meta in self.root.glob("upl_*.json"):
                upload_id = meta.stem
                if upload_id in keep_set or not UPLOAD_ID_RE.match(upload_id):
                    continue
                try:
                    if meta.stat().st_mtime < cutoff:
                        size = (self.root / f"{upload_id}.png").stat().st_size
                        (self.root / f"{upload_id}.png").unlink(missing_ok=True)
                        meta.unlink(missing_ok=True)
                        self._count = max(0, self._count - 1)
                        self._total_bytes = max(0, self._total_bytes - size)
                        removed += 1
                except OSError:
                    continue
            self._reconcile()
        return removed


class _CappedBuffer(io.BytesIO):
    def __init__(self, limit: int) -> None:
        super().__init__()
        self.limit = limit

    def write(self, data: Any) -> int:
        if self.tell() + len(data) > self.limit:
            raise PayloadTooLarge(f"Re-encoded upload exceeds {self.limit} bytes.")
        return super().write(data)


class OutputStore:
    def __init__(self, root: Path) -> None:
        self.root = root
        root.mkdir(parents=True, exist_ok=True)

    def job_dir(self, job_id: str) -> Path:
        path = confined(self.root, check_job_id(job_id))
        path.mkdir(parents=True, exist_ok=True)
        return path

    def result_path(self, job_id: str, filename: str) -> Path:
        if not re.fullmatch(r"output\.[a-z0-9]{2,5}", filename):
            raise NotFound("Result not found.")
        return confined(self.root, check_job_id(job_id), filename)

    def remove(self, job_id: str) -> None:
        directory = confined(self.root, check_job_id(job_id))
        if directory.is_dir():
            for child in directory.iterdir():
                child.unlink(missing_ok=True)
            directory.rmdir()
