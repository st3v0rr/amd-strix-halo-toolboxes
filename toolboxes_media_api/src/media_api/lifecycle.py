"""Model lifecycle: lazy loading, one resident model, admission before loading.

At most one (model, profile) is resident. Switching drops every reference,
runs the garbage collector and empties the torch allocator cache *before* the
next model loads, and the admission check runs after that release — on Strix
Halo the GPU's memory is the host's memory, so what counts is what the box has
free at that moment, llama-server containers included.
"""

from __future__ import annotations

import gc
import logging
import sys
import threading
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .config import Settings
from .errors import ModelUnavailable, ProviderError
from .jobs import Job, JobContext
from .providers.base import GenerationRequest, Provider
from .registry import ModelSpec, ProfileSpec

log = logging.getLogger("media_api.lifecycle")
GIB = 1024**3


@dataclass(frozen=True)
class MemorySnapshot:
    host_available_gb: float | None
    device_free_gb: float | None

    @property
    def available_gb(self) -> float | None:
        values = [v for v in (self.host_available_gb, self.device_free_gb) if v is not None]
        return min(values) if values else None


def probe_memory(meminfo: Path = Path("/proc/meminfo")) -> MemorySnapshot:
    host = None
    try:
        for line in meminfo.read_text().splitlines():
            if line.startswith("MemAvailable:"):
                host = int(line.split()[1]) * 1024 / GIB
                break
    except (OSError, ValueError, IndexError):
        pass
    device = None
    torch = sys.modules.get("torch")  # never import torch just to look
    if torch is not None:
        try:
            if torch.cuda.is_available():
                free, total = torch.cuda.mem_get_info()
                # An APU that reports only its small carve-out would make every
                # check fail; the host figure already covers unified memory.
                if total >= 16 * GIB:
                    device = free / GIB
        except Exception:  # noqa: S110 - a failed probe just means "unknown"
            pass
    return MemorySnapshot(host, device)


def release_memory() -> None:
    gc.collect()
    torch = sys.modules.get("torch")
    if torch is None:
        return
    try:
        if torch.cuda.is_available():
            torch.cuda.synchronize()
            torch.cuda.empty_cache()
            torch.cuda.ipc_collect()
    except Exception as exc:  # pragma: no cover - device specific
        log.warning("releasing device memory failed: %s", exc)


ProviderFactory = Callable[[Settings, ModelSpec, ProfileSpec], Provider]
RequestBuilder = Callable[[Job, ModelSpec, ProfileSpec], GenerationRequest]


class ModelManager:
    def __init__(
        self,
        settings: Settings,
        factory: ProviderFactory,
        build_request: RequestBuilder,
        probe: Callable[[], MemorySnapshot] = probe_memory,
        ensure_files: Callable[[ModelSpec, ProfileSpec, str, JobContext], None] | None = None,
    ) -> None:
        self.settings = settings
        self._factory = factory
        self._build_request = build_request
        self._probe = probe
        self._ensure_files = ensure_files
        self._lock = threading.Lock()
        self._provider: Provider | None = None
        self._key: tuple[str, str] | None = None
        self.loads: list[tuple[str, str]] = []
        self.unloads: list[tuple[str, str]] = []

    @property
    def resident(self) -> tuple[str, str] | None:
        return self._key

    def unload(self) -> None:
        with self._lock:
            self._unload_locked()

    def _unload_locked(self) -> None:
        if self._provider is None:
            return
        key = self._key
        try:
            self._provider.unload()
        finally:
            self._provider = None
            self._key = None
            release_memory()
            if key is not None:
                self.unloads.append(key)
                log.info("unloaded %s/%s", *key)

    def admit(self, profile: ProfileSpec) -> None:
        mode = self.settings.memory_check
        if mode == "off" or profile.estimated_memory_gb <= 0:
            return
        snapshot = self._probe()
        available = snapshot.available_gb
        if available is None:
            log.warning("cannot determine free memory; skipping the admission check")
            return
        needed = profile.estimated_memory_gb + self.settings.memory_reserve_gb
        if needed <= available:
            return
        message = (
            f"Profile '{profile.id}' needs about {profile.estimated_memory_gb:.0f} GB plus a "
            f"{self.settings.memory_reserve_gb:.0f} GB reserve, but only {available:.1f} GB are free. "
            "Stop other GPU containers (such as llama-server) or choose a smaller profile."
        )
        if mode == "warn":
            log.warning(message)
            return
        raise ProviderError(
            "insufficient_memory",
            message,
            {"needed_gb": round(needed, 1), "available_gb": round(available, 1)},
        )

    def run(self, job: Job, ctx: JobContext) -> dict[str, Any]:
        model = self.settings.registry.get(job.model)
        profile = model.profile(job.profile)
        with self._lock:
            key = (model.id, profile.id)
            if self._ensure_files is not None:
                self._ensure_files(model, profile, job.task, ctx)
            if self._key != key:
                self._unload_locked()
                self.admit(profile)
                ctx.report("loading_model", 0.0)
                provider = self._factory(self.settings, model, profile)
                try:
                    provider.load(ctx)
                except BaseException:
                    self._provider = provider
                    self._key = key
                    self._unload_locked()
                    raise
                self._provider, self._key = provider, key
                self.loads.append(key)
                log.info("loaded %s/%s", *key)
            assert self._provider is not None
            request = self._build_request(job, model, profile)
            ctx.report("generating", 0.0)
            artifact = self._provider.generate(request, ctx)
            return artifact.describe(job.id)


def missing_files_error(model: ModelSpec, profile: ProfileSpec, missing: list[str]) -> ModelUnavailable:
    return ModelUnavailable(
        f"Model files for '{model.id}' profile '{profile.id}' are missing.",
        code="model_files_missing",
        details={
            "model": model.id,
            "profile": profile.id,
            "missing": missing[:50],
            "hint": (
                f"Fetch them with: media-api-models fetch {model.id} --profile {profile.id} "
                "(or set MEDIA_ALLOW_DOWNLOADS=1 to fetch on first use)."
            ),
        },
    )
