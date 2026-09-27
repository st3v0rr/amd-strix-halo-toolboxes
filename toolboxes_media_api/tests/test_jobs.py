from __future__ import annotations

import json
import threading
import time

import pytest

from media_api.app import create_app
from media_api.config import load_settings
from media_api.errors import ApiError, NotFound
from media_api.jobs import Job, JobQueue, JobStatus, JobStore
from media_api.providers.mock import MockProvider

from .conftest import AUTH, upload, wait

IMG = {"prompt": "a lighthouse", "width": 256, "height": 256, "steps": 3}


def post(client, body=None, path="/api/v1/images/generations"):
    return client.post(path, headers=AUTH, json=body or IMG)


def test_jobs_run_one_at_a_time_in_order(make_client):
    client = make_client(MEDIA_MOCK_STEP_SECONDS="0.01")
    ids = [post(client, {**IMG, "seed": i}).json()["id"] for i in range(5)]
    jobs = [wait(client, i) for i in ids]
    assert all(j["status"] == "succeeded" for j in jobs)
    assert client.app.state.queue.max_concurrent_seen == 1
    starts = [j["started_at"] for j in jobs]
    assert starts == sorted(starts)


def test_queue_full_is_rejected_predictably(make_client):
    client = make_client(MEDIA_MAX_QUEUED_JOBS="2")
    gate = threading.Event()
    MockProvider.gate = gate
    try:
        first = post(client).json()["id"]
        deadline = time.time() + 5
        while (
            client.get(f"/api/v1/jobs/{first}", headers=AUTH).json()["status"] != "running"
            and time.time() < deadline
        ):
            time.sleep(0.01)
        queued = [post(client).status_code for _ in range(2)]
        full = post(client)
        assert queued == [202, 202]
        assert full.status_code == 429 and full.json()["error"]["code"] == "queue_full"
    finally:
        gate.set()
        MockProvider.gate = None


def test_cancel_queued_and_running(client):
    gate = threading.Event()
    MockProvider.gate = gate
    try:
        running = post(client).json()["id"]
        queued = post(client).json()
        assert queued["status"] == "queued" and queued["queue_position"] == 0
        deadline = time.time() + 5
        while (
            client.get(f"/api/v1/jobs/{running}", headers=AUTH).json()["status"] != "running"
            and time.time() < deadline
        ):
            time.sleep(0.01)
        cancelled = client.post(f"/api/v1/jobs/{queued['id']}/cancel", headers=AUTH).json()
        assert cancelled["status"] == "cancelled"
        response = client.post(f"/api/v1/jobs/{running}/cancel", headers=AUTH)
        assert response.status_code == 200 and response.json()["cancel_requested"]
        assert wait(client, running)["status"] == "cancelled"
        again = client.post(f"/api/v1/jobs/{running}/cancel", headers=AUTH)
        assert again.status_code == 409 and again.json()["error"]["code"] == "job_finished"
        assert client.get(f"/api/v1/jobs/{running}/result", headers=AUTH).status_code == 409
    finally:
        gate.set()
        MockProvider.gate = None


def test_cancel_churn_removes_queue_entries_and_bounds_records(make_client):
    client = make_client(MEDIA_MAX_RETAINED_JOBS="3")
    gate = threading.Event()
    MockProvider.gate = gate
    try:
        running = post(client).json()["id"]
        deadline = time.time() + 5
        while client.app.state.store.get(running).status is not JobStatus.RUNNING and time.time() < deadline:
            time.sleep(0.01)
        for _ in range(25):
            job_id = post(client).json()["id"]
            response = client.post(f"/api/v1/jobs/{job_id}/cancel", headers=AUTH)
            assert response.status_code == 200
        queue = client.app.state.queue
        assert list(queue._pending) == []
        cancelled = [j for j in client.app.state.store.recent(100) if j.status is JobStatus.CANCELLED]
        assert len(cancelled) <= 3
        assert len(list(client.app.state.store.dir.glob("job_*.json"))) <= 4
    finally:
        gate.set()
        MockProvider.gate = None


def test_stop_closes_submissions_cancels_work_and_joins(tmp_path):
    store = JobStore(tmp_path)

    def runner(job, ctx):
        while not ctx.cancelled:
            time.sleep(0.001)
        ctx.check_cancelled()
        return {}

    queue = JobQueue(store, runner, max_queued=2)
    queue.start()
    active = Job("job_" + "a" * 32, "task", "model", "profile", {})
    pending = Job("job_" + "b" * 32, "task", "model", "profile", {})
    queue.submit(active)
    deadline = time.time() + 5
    while active.status is not JobStatus.RUNNING and time.time() < deadline:
        time.sleep(0.001)
    queue.submit(pending)
    threads = list(queue._threads)
    queue.stop()
    assert active.status is JobStatus.CANCELLED and pending.status is JobStatus.CANCELLED
    assert all(not thread.is_alive() for thread in threads)
    with pytest.raises(ApiError, match="shutting down"):
        queue.submit(Job("job_" + "c" * 32, "task", "model", "profile", {}))


def test_failure_is_structured_and_the_queue_continues(client):
    failed = wait(client, post(client, {**IMG, "prompt": "boom [mock:fail]"}).json()["id"])
    assert failed["status"] == "failed" and failed["error"]["code"] == "mock_failure"
    assert wait(client, post(client).json()["id"])["status"] == "succeeded"


def test_unfinished_jobs_fail_as_interrupted_after_restart(env, tmp_path):
    settings = load_settings(env)
    store = JobStore(settings.state_dir)
    store.save(Job("job_" + "1" * 32, "text-to-image", "qwen-image-2512", "fp8", {"prompt": "x"}))
    running = Job(
        "job_" + "2" * 32,
        "text-to-image",
        "qwen-image-2512",
        "fp8",
        {"prompt": "y"},
        status=JobStatus.RUNNING,
    )
    store.save(running)
    reloaded = JobStore(settings.state_dir)
    for job_id in ("job_" + "1" * 32, "job_" + "2" * 32):
        job = reloaded.get(job_id)
        assert job.status is JobStatus.FAILED and job.error["code"] == "interrupted"


def test_restore_rejects_mismatched_embedded_job_id(tmp_path):
    store = JobStore(tmp_path)
    job = Job("job_" + "1" * 32, "task", "model", "profile", {})
    record = job.to_record()
    record["id"] = "job_" + "2" * 32
    (store.dir / f"{job.id}.json").write_text(json.dumps(record))
    reloaded = JobStore(tmp_path)
    with pytest.raises(NotFound):
        reloaded.get(job.id)


def test_lazy_loading_and_one_resident_model(client):
    manager = client.app.state.manager
    assert manager.resident is None and manager.loads == []  # nothing loads at startup
    wait(client, post(client).json()["id"])
    wait(client, post(client).json()["id"])
    assert manager.loads == [("qwen-image-2512", "fp8")]
    wait(client, post(client, {**IMG, "profile": "lightning-4step"}).json()["id"])
    video = {"prompt": "waves", "width": 256, "height": 256, "steps": 1, "num_frames": 124}
    wait(client, post(client, video, "/api/v1/videos/generations").json()["id"])
    assert manager.loads[-2:] == [("qwen-image-2512", "lightning-4step"), ("minimax-h3", "int8")]
    assert manager.unloads == [("qwen-image-2512", "fp8"), ("qwen-image-2512", "lightning-4step")]
    assert manager.resident == ("minimax-h3", "int8")


def test_same_profile_minimax_partition_switch_checks_task_files(client):
    manager = client.app.state.manager
    checked: list[str] = []
    manager._ensure_files = lambda model, profile, task, ctx: checked.append(task)
    video = {"prompt": "waves", "width": 256, "height": 256, "steps": 1, "num_frames": 124}
    first = post(client, video, "/api/v1/videos/generations").json()["id"]
    assert wait(client, first)["status"] == "succeeded"
    reference_id = upload(client)["id"]
    second = post(
        client,
        {**video, "reference_image_ids": [reference_id]},
        "/api/v1/videos/generations",
    ).json()["id"]
    assert wait(client, second)["status"] == "succeeded"

    assert checked == ["text-to-video", "reference-to-video"]
    assert manager.loads == [("minimax-h3", "int8")]


def test_admission_check_refuses_before_loading(make_client):
    client = make_client(memory_gb=20.0, MEDIA_MEMORY_CHECK="strict")
    job = wait(client, post(client).json()["id"])
    assert job["status"] == "failed" and job["error"]["code"] == "insufficient_memory"
    assert client.app.state.manager.loads == []
    roomy = make_client(memory_gb=200.0, MEDIA_MEMORY_CHECK="strict")
    assert wait(roomy, post(roomy).json()["id"])["status"] == "succeeded"


def test_retention_cleanup_removes_old_results(make_client):
    client = make_client(MEDIA_MAX_RETAINED_JOBS="1")
    first = wait(client, post(client).json()["id"])
    second = wait(client, post(client).json()["id"])
    client.app.state.cleanup_once()
    assert client.get(f"/api/v1/jobs/{first['id']}", headers=AUTH).status_code == 404
    assert client.get(f"/api/v1/jobs/{second['id']}/result", headers=AUTH).status_code == 200


def test_app_factory_does_not_start_workers_when_asked(env):
    app = create_app(load_settings(env), start_workers=False)
    assert app.state.queue._threads == []
