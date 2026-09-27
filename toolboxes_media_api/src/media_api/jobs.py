"""Persistent jobs and the single-GPU queue.

States: queued → running → succeeded | failed | cancelled. Nothing else, and a
terminal state never changes again. Each job is one JSON file in
MEDIA_STATE_DIR/jobs, written atomically; jobs that were queued or running
when the process stopped come back as failed/interrupted rather than silently
disappearing or re-running against a changed configuration.

One worker thread runs jobs one at a time (the model lifecycle below assumes
it), so two jobs can never load models concurrently.
"""

from __future__ import annotations

import json
import logging
import threading
import time
from collections import deque
from collections.abc import Callable
from contextlib import suppress
from dataclasses import asdict, dataclass, field
from enum import StrEnum
from pathlib import Path
from typing import Any

from .errors import ApiError, Conflict, JobCancelled, NotFound, ProviderError, TooManyRequests
from .storage import JOB_ID_RE, atomic_write_json, check_job_id

log = logging.getLogger("media_api.jobs")


class JobStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


TERMINAL = frozenset({JobStatus.SUCCEEDED, JobStatus.FAILED, JobStatus.CANCELLED})


@dataclass
class Job:
    id: str
    task: str
    model: str
    profile: str
    params: dict[str, Any]
    upload_ids: list[str] = field(default_factory=list)
    status: JobStatus = JobStatus.QUEUED
    stage: str = "queued"
    progress: float = 0.0
    created_at: float = field(default_factory=time.time)
    started_at: float | None = None
    finished_at: float | None = None
    cancel_requested: bool = False
    result: dict[str, Any] | None = None
    error: dict[str, Any] | None = None

    def to_record(self) -> dict[str, Any]:
        record = asdict(self)
        record["status"] = self.status.value
        return record

    @classmethod
    def from_record(cls, record: dict[str, Any]) -> Job:
        record = dict(record)
        record["status"] = JobStatus(record["status"])
        return cls(**record)

    def public(self, queue_position: int | None = None) -> dict[str, Any]:
        def iso(ts: float | None) -> str | None:
            return None if ts is None else time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts))

        data: dict[str, Any] = {
            "id": self.id,
            "object": "job",
            "task": self.task,
            "model": self.model,
            "profile": self.profile,
            "status": self.status.value,
            "stage": self.stage,
            "progress": round(self.progress, 4),
            "created_at": iso(self.created_at),
            "started_at": iso(self.started_at),
            "finished_at": iso(self.finished_at),
            "cancel_requested": self.cancel_requested,
            "params": self.params,
            "result": self.result,
            "error": self.error,
        }
        if queue_position is not None:
            data["queue_position"] = queue_position
        return data


class JobContext:
    """What a running job sees: progress reporting and cooperative cancellation."""

    def __init__(self, job: Job, store: JobStore, cancel_event: threading.Event) -> None:
        self.job = job
        self._store = store
        self._cancel = cancel_event
        self._last_save = 0.0

    @property
    def cancelled(self) -> bool:
        return self._cancel.is_set()

    def check_cancelled(self) -> None:
        if self._cancel.is_set():
            raise JobCancelled()

    def report(self, stage: str, progress: float | None = None) -> None:
        self.check_cancelled()
        now = time.monotonic()
        changed = stage != self.job.stage
        with self._store.lock:
            self.job.stage = stage
            if progress is not None:
                self.job.progress = max(0.0, min(1.0, progress))
        # Progress lives in memory for polling; the file is refreshed at most
        # twice a second, and on every stage change.
        if changed or now - self._last_save > 0.5:
            self._last_save = now
            self._store.save(self.job)


Runner = Callable[[Job, JobContext], dict[str, Any]]


class JobStore:
    def __init__(self, state_dir: Path) -> None:
        self.dir = state_dir / "jobs"
        self.dir.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self._jobs: dict[str, Job] = {}
        self._load()

    def _load(self) -> None:
        for path in sorted(self.dir.glob("job_*.json")):
            if not JOB_ID_RE.match(path.stem):
                continue
            try:
                job = Job.from_record(json.loads(path.read_text(encoding="utf-8")))
            except (OSError, ValueError, TypeError, KeyError):
                log.warning("skipping unreadable job record %s", path.name)
                continue
            if job.id != path.stem:
                log.warning("skipping job record %s with mismatched embedded id", path.name)
                continue
            if job.status not in TERMINAL:
                job.status = JobStatus.FAILED
                job.stage = "finished"
                job.finished_at = time.time()
                job.error = {
                    "code": "interrupted",
                    "message": "The server stopped before this job finished; submit it again.",
                }
                self._write(job)
            self._jobs[job.id] = job

    def _write(self, job: Job) -> None:
        atomic_write_json(self.dir / f"{job.id}.json", job.to_record())

    def save(self, job: Job) -> None:
        with self.lock:
            self._jobs[job.id] = job
            self._write(job)

    def get(self, job_id: str) -> Job:
        check_job_id(job_id)
        with self.lock:
            job = self._jobs.get(job_id)
        if job is None:
            raise NotFound("Job not found.")
        return job

    def recent(self, limit: int = 50) -> list[Job]:
        with self.lock:
            jobs = sorted(self._jobs.values(), key=lambda j: j.created_at, reverse=True)
        return jobs[:limit]

    def active_upload_ids(self) -> set[str]:
        with self.lock:
            return {u for j in self._jobs.values() if j.status not in TERMINAL for u in j.upload_ids}

    def delete(self, job_id: str) -> None:
        with self.lock:
            self._jobs.pop(job_id, None)
            (self.dir / f"{job_id}.json").unlink(missing_ok=True)

    def expired(self, max_age_seconds: float, max_count: int) -> list[str]:
        """Terminal jobs past their retention, oldest first."""
        cutoff = time.time() - max_age_seconds
        with self.lock:
            done = sorted(
                (j for j in self._jobs.values() if j.status in TERMINAL),
                key=lambda j: j.finished_at or j.created_at,
            )
        old = [j.id for j in done if (j.finished_at or j.created_at) < cutoff]
        overflow = max(0, len(done) - max_count)
        extra = [j.id for j in done[:overflow] if j.id not in old]
        return old + extra

    def prune_cancelled_without_output(self, max_count: int) -> None:
        """Bound records created by repeated submit/cancel churn between cleanup passes."""
        with self.lock:
            cancelled = sorted(
                (
                    job
                    for job in self._jobs.values()
                    if job.status is JobStatus.CANCELLED and job.started_at is None
                ),
                key=lambda job: job.finished_at or job.created_at,
            )
            for job in cancelled[: max(0, len(cancelled) - max_count)]:
                self._jobs.pop(job.id, None)
                (self.dir / f"{job.id}.json").unlink(missing_ok=True)


class JobQueue:
    def __init__(
        self,
        store: JobStore,
        runner: Runner,
        max_queued: int,
        workers: int = 1,
        max_retained_jobs: int = 500,
    ) -> None:
        self.store = store
        self._runner = runner
        self._max_queued = max_queued
        self._workers = workers
        self._pending: deque[str] = deque()
        self._cancel_events: dict[str, threading.Event] = {}
        self._threads: list[threading.Thread] = []
        self._condition = threading.Condition(self.store.lock)
        self._accepting = True
        self._max_retained_jobs = max_retained_jobs
        self._running = 0
        self.max_concurrent_seen = 0

    def start(self) -> None:
        for index in range(self._workers):
            thread = threading.Thread(target=self._work, name=f"media-worker-{index}", daemon=True)
            thread.start()
            self._threads.append(thread)

    def stop(self, timeout: float = 5.0) -> None:
        with self._condition:
            self._accepting = False
            for event in self._cancel_events.values():
                event.set()
            while self._pending:
                job_id = self._pending.popleft()
                try:
                    job = self.store.get(job_id)
                except NotFound:
                    continue
                if job.status is JobStatus.QUEUED:
                    job.cancel_requested = True
                    self._finish(job, JobStatus.CANCELLED)
            self.store.prune_cancelled_without_output(self._max_retained_jobs)
            self._condition.notify_all()
        for thread in self._threads:
            thread.join(timeout)
            if thread.is_alive():
                # Never unload model state while a worker may still be using it.
                thread.join()
        self._threads.clear()

    def submit(self, job: Job) -> Job:
        with self._condition:
            if not self._accepting:
                raise ApiError("The service is shutting down.", code="service_stopping", status=503)
            if len(self._pending) >= self._max_queued:
                raise TooManyRequests(
                    f"The queue is full ({self._max_queued} jobs waiting); try again later.",
                    code="queue_full",
                )
            self._pending.append(job.id)
            self._cancel_events[job.id] = threading.Event()
            self.store.save(job)
            self._condition.notify()
        return job

    def position(self, job_id: str) -> int | None:
        with self.store.lock:
            try:
                return self._pending.index(job_id)
            except ValueError:
                return None

    def cancel(self, job_id: str) -> Job:
        job = self.store.get(job_id)
        with self.store.lock:
            if job.status in TERMINAL:
                raise Conflict(
                    f"Job is already {job.status.value}.",
                    code="job_finished",
                    details={"status": job.status.value},
                )
            job.cancel_requested = True
            event = self._cancel_events.get(job_id)
            if event is not None:
                event.set()
            if job.status is JobStatus.QUEUED:
                with suppress(ValueError):
                    self._pending.remove(job_id)
                self._finish(job, JobStatus.CANCELLED)
                self.store.prune_cancelled_without_output(self._max_retained_jobs)
            else:
                self.store.save(job)
        return job

    def _finish(self, job: Job, status: JobStatus, error: dict[str, Any] | None = None) -> None:
        job.status = status
        job.stage = "finished"
        job.finished_at = time.time()
        job.error = error
        if status is JobStatus.SUCCEEDED:
            job.progress = 1.0
        self._cancel_events.pop(job.id, None)
        self.store.save(job)

    def _work(self) -> None:
        while True:
            with self._condition:
                while not self._pending and self._accepting:
                    self._condition.wait()
                if not self._pending:
                    return
                job_id = self._pending.popleft()
                try:
                    job = self.store.get(job_id)
                except NotFound:
                    continue
                if job.status is not JobStatus.QUEUED:
                    continue  # cancelled while waiting
                event = self._cancel_events.setdefault(job_id, threading.Event())
                job.status = JobStatus.RUNNING
                job.stage = "starting"
                job.started_at = time.time()
                self.store.save(job)
                self._running += 1
                self.max_concurrent_seen = max(self.max_concurrent_seen, self._running)
            try:
                result = self._runner(job, JobContext(job, self.store, event))
            except JobCancelled:
                with self.store.lock:
                    self._finish(job, JobStatus.CANCELLED)
            except ProviderError as exc:
                log.warning("job %s failed: %s", job.id, exc.code)
                error: dict[str, Any] = {"code": exc.code, "message": exc.message}
                if exc.details:
                    error["details"] = exc.details
                with self.store.lock:
                    self._finish(job, JobStatus.FAILED, error)
            except ApiError as exc:
                log.warning("job %s failed: %s", job.id, exc.code)
                with self.store.lock:
                    self._finish(job, JobStatus.FAILED, exc.to_dict()["error"])
            except Exception:
                # The traceback goes to the log (it never contains credentials:
                # workers do not see request headers); the client gets a
                # generic message instead of internals.
                log.exception("job %s crashed", job.id)
                with self.store.lock:
                    self._finish(
                        job,
                        JobStatus.FAILED,
                        {"code": "internal_error", "message": "Generation failed; see the server log."},
                    )
            else:
                with self.store.lock:
                    if event.is_set():
                        self._finish(job, JobStatus.CANCELLED)
                    else:
                        job.result = result
                        self._finish(job, JobStatus.SUCCEEDED)
            finally:
                with self.store.lock:
                    self._running -= 1
