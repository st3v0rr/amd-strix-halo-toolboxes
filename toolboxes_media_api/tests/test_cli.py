"""`media-api-models`: the JSON forms the web interface reads, and the key it does not need."""

from __future__ import annotations

import json
import sys
import time
import types
from pathlib import Path

import pytest

from media_api import cli
from media_api.__main__ import main as serve

from .conftest import API_KEY


@pytest.fixture
def cli_env(env: dict[str, str], monkeypatch: pytest.MonkeyPatch) -> Path:
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    # The model tool reads the registry and the tree, never a credential.
    monkeypatch.delenv("MEDIA_API_KEY", raising=False)
    monkeypatch.delenv("MEDIA_API_KEY_FILE", raising=False)
    models = Path(env["MEDIA_MODELS_DIR"])
    models.mkdir(parents=True)
    return models


def _touch(root: Path, rel: str, data: bytes = b"x") -> None:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def _events(text: str) -> list[dict]:
    return [json.loads(line) for line in text.splitlines() if line.strip()]


def test_check_json_needs_no_key_and_reports_every_profile(cli_env: Path, capsys) -> None:
    assert cli.main(["check", "--json"]) == 0
    doc = json.loads(capsys.readouterr().out)
    assert doc["version"] == 1
    assert doc["models_dir"] == str(cli_env)
    models = {m["id"]: m for m in doc["models"]}
    assert set(models) == {"qwen-image-2512", "qwen-image-edit-2511", "minimax-h3"}
    fp8 = next(p for p in models["qwen-image-2512"]["profiles"] if p["id"] == "fp8")
    assert fp8["default"] is True and fp8["available"] is False and fp8["downloadable"] is True
    assert "diffusion_models/qwen_image_2512_fp8_e4m3fn.safetensors" in fp8["missing"]
    nf4 = next(p for p in models["qwen-image-2512"]["profiles"] if p["id"] == "nf4-bitsandbytes")
    # An unsupported profile says why and makes no availability claim.
    assert nf4["status"] == "unsupported" and nf4["reason"] and "available" not in nf4


def test_check_json_reports_availability_per_task(cli_env: Path, capsys) -> None:
    base = "diffusers/MiniMax-H3"
    for rel in (
        "modular_model_index.json",
        "scheduler/scheduler_config.json",
        "audio_scheduler/scheduler_config.json",
        "tokenizer/tokenizer_config.json",
        "tokenizer/tokenizer.json",
        "processor/processor_config.json",
    ):
        _touch(cli_env, f"{base}/{rel}")
    for component in ("transformer", "text_encoder", "vae", "audio_vae"):
        _touch(cli_env, f"{base}/{component}/config.json")
        _touch(cli_env, f"{base}/{component}/model.safetensors")
    assert cli.main(["check", "--json"]) == 0
    doc = json.loads(capsys.readouterr().out)
    h3 = next(m for m in doc["models"] if m["id"] == "minimax-h3")
    int8 = next(p for p in h3["profiles"] if p["id"] == "int8")
    # Everything but the reference partition is there: three tasks can run.
    assert int8["tasks_available"] == {
        "text-to-video": True,
        "image-to-video": True,
        "start-end-to-video": True,
        "reference-to-video": False,
    }
    assert int8["available"] is False
    assert all(m.startswith(f"{base}/transformer_ref") for m in int8["missing"])


def test_text_check_is_unchanged(cli_env: Path, capsys) -> None:
    assert cli.main(["check"]) == 0
    out = capsys.readouterr().out
    assert "qwen-image-2512/fp8 [supported, ~36 GB]: missing" in out
    assert "qwen-image-2512/nf4-bitsandbytes: unsupported" in out


def test_the_service_still_fails_closed(env: dict[str, str], monkeypatch: pytest.MonkeyPatch) -> None:
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    monkeypatch.delenv("MEDIA_API_KEY")
    with pytest.raises(SystemExit) as exc:
        serve()
    assert exc.value.code == 2


class FakeHub:
    """Stands in for huggingface_hub: records calls, writes small files, never touches a network."""

    def __init__(self, sizes: dict[str, int], tree: dict[str, list[tuple[str, int]]]) -> None:
        self.sizes, self.tree, self.calls = sizes, tree, []
        module = types.ModuleType("huggingface_hub")
        hub = self

        class HfApi:
            def get_paths_info(self, repo: str, paths: list[str], revision: str | None = None):
                hub.calls.append(("paths_info", repo, tuple(paths), revision))
                return [types.SimpleNamespace(path=p, size=hub.sizes[p]) for p in paths]

            def list_repo_tree(self, repo: str, revision: str | None = None, recursive: bool = False):
                hub.calls.append(("tree", repo, revision, recursive))
                return [types.SimpleNamespace(path=p, size=s) for p, s in hub.tree.get(repo, [])]

        def hf_hub_download(repo: str, filename: str, revision: str | None = None, local_dir: Path = Path()):
            hub.calls.append(("download", repo, filename, revision))
            path = Path(local_dir) / filename
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"w")
            return str(path)

        def snapshot_download(
            repo: str, revision: str | None = None, local_dir: Path = Path(), allow_patterns=()
        ):
            hub.calls.append(("snapshot", repo, revision, tuple(allow_patterns)))
            Path(local_dir).mkdir(parents=True, exist_ok=True)
            return str(local_dir)

        module.HfApi = HfApi  # type: ignore[attr-defined]
        module.hf_hub_download = hf_hub_download  # type: ignore[attr-defined]
        module.snapshot_download = snapshot_download  # type: ignore[attr-defined]
        self.module = module


LORA = "Qwen-Image-2512-Lightning-4steps-V1.0-bf16.safetensors"
TRANSFORMER = "split_files/diffusion_models/qwen_image_2512_fp8_e4m3fn.safetensors"
TEXT_ENCODER = "split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors"


def _hub(monkeypatch: pytest.MonkeyPatch, scale: int = 1) -> FakeHub:
    hub = FakeHub(
        sizes={LORA: 100 * scale, TRANSFORMER: 1000 * scale, TEXT_ENCODER: 500 * scale},
        tree={
            "Qwen/Qwen-Image-2512": [
                ("model_index.json", 1 * scale),
                ("scheduler/scheduler_config.json", 2 * scale),
                ("vae/config.json", 3 * scale),
                ("vae/diffusion_pytorch_model.safetensors", 40 * scale),
                ("transformer/diffusion_pytorch_model-00001-of-00009.safetensors", 9999 * scale),
                ("transformer/config.json", 4 * scale),
            ]
        },
    )
    monkeypatch.setitem(sys.modules, "huggingface_hub", hub.module)
    return hub


def test_fetch_json_plans_then_reports_every_file(
    cli_env: Path, monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    hub = _hub(monkeypatch)
    _touch(cli_env, "loras/" + LORA)  # already there: not planned, not fetched
    assert cli.main(["fetch", "qwen-image-2512", "--profile", "lightning-4step", "--json"]) == 0
    events = _events(capsys.readouterr().out)
    kinds = [e["event"] for e in events]
    assert kinds[0] == "plan" and kinds[-1] == "done"
    plan = events[0]
    assert (plan["model"], plan["profile"], plan["task"]) == ("qwen-image-2512", "lightning-4step", None)
    paths = [f["path"] for f in plan["files"]]
    assert "loras/" + LORA not in paths
    by_path = {f["path"]: f for f in plan["files"]}
    # Only the patterns the profile needs count: the 9999-byte transformer shard is not one.
    assert by_path["diffusers/Qwen-Image-2512"]["bytes"] == 1 + 2 + 3 + 40 + 4
    assert by_path["diffusion_models/qwen_image_2512_fp8_e4m3fn.safetensors"]["bytes"] == 1000
    assert plan["total_bytes"] == 50 + 1000 + 500
    assert kinds.count("file") == kinds.count("fetched") == len(paths)
    assert events[-1]["fetched"] == paths
    assert (cli_env / "diffusion_models/qwen_image_2512_fp8_e4m3fn.safetensors").is_file()
    assert not [c for c in hub.calls if c[0] == "download" and c[2] == LORA]


def test_fetch_json_refuses_when_the_disk_is_too_small(
    cli_env: Path, monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    hub = _hub(monkeypatch, scale=10**15)
    assert cli.main(["fetch", "qwen-image-2512", "--json"]) == 1
    events = _events(capsys.readouterr().out)
    assert events[0]["event"] == "plan"
    assert events[-1]["event"] == "error" and "not enough space" in events[-1]["message"]
    assert not [c for c in hub.calls if c[0] in ("download", "snapshot")]


def test_fetch_json_rejects_unusable_requests_as_events(cli_env: Path, capsys) -> None:
    assert cli.main(["fetch", "qwen-image-2512", "--profile", "nf4-bitsandbytes", "--json"]) == 1
    assert (
        cli.main(["fetch", "minimax-h3", "--profile", "turbo", "--task", "reference-to-video", "--json"]) == 1
    )
    assert cli.main(["fetch", "nope", "--json"]) == 1
    events = _events(capsys.readouterr().out)
    assert [e["event"] for e in events] == ["error", "error", "error"]
    assert "cannot be used" in events[0]["message"]
    assert "does not support" in events[1]["message"]
    assert "Unknown model" in events[2]["message"]


def test_fetch_text_output_is_unchanged_but_space_is_checked(
    cli_env: Path, monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    hub = _hub(monkeypatch)
    assert cli.main(["fetch", "qwen-image-2512"]) == 0
    out = capsys.readouterr().out.splitlines()
    assert out[-1] == "done"
    assert "fetched diffusion_models/qwen_image_2512_fp8_e4m3fn.safetensors" in out
    # Sizes are looked up for every fetch now: the space check needs them.
    assert [c for c in hub.calls if c[0] in ("paths_info", "tree")]


def test_space_needed_counts_the_reserve_and_headroom() -> None:
    gib = cli.GIB
    assert cli.space_needed(10 * gib, gib) == 12 * gib  # headroom: at least 1 GiB
    assert cli.space_needed(100 * gib, 0) == 102 * gib  # headroom: 2 %


def _settings(cli_env: Path):
    from media_api.config import load_settings

    settings = load_settings(require_secrets=False)
    model = settings.registry.get("qwen-image-2512")
    return settings, model, model.profile("fp8")


def test_a_download_that_fits_only_without_the_reserve_is_refused(
    cli_env: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    hub = _hub(monkeypatch)
    settings, model, profile = _settings(cli_env)
    total = 50 + 1000 + 500
    free = {"value": total + 10}
    monkeypatch.setattr(cli.shutil, "disk_usage", lambda _p: types.SimpleNamespace(free=free["value"]))
    with pytest.raises(RuntimeError, match="reserve"):
        cli.fetch_profile(settings, model, profile)
    assert not [c for c in hub.calls if c[0] in ("download", "snapshot")]
    free["value"] = cli.space_needed(total, settings.limits.min_free_disk_bytes)
    assert cli.fetch_profile(settings, model, profile)


def test_unknown_sizes_need_a_guard(cli_env: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    hub = _hub(monkeypatch)

    def no_size(*_a, **_k):
        raise OSError("offline")

    monkeypatch.setattr(hub.module.HfApi, "get_paths_info", no_size)
    monkeypatch.setattr(cli.shutil, "disk_usage", lambda _p: types.SimpleNamespace(free=10**15))
    settings, model, profile = _settings(cli_env)
    # The service's own first-use download has no guard: it refuses.
    with pytest.raises(RuntimeError, match="size unknown"):
        cli.fetch_profile(settings, model, profile)
    # The CLI runs a DiskGuard, which bounds it.
    assert cli.fetch_profile(settings, model, profile, allow_unknown_size=True)


def test_the_guard_trips_below_the_reserve(tmp_path: Path) -> None:
    readings = iter([500, 400, 50, 10])
    tripped: list[int] = []
    with cli.DiskGuard(tmp_path, 100, tripped.append, interval=0.01, free=lambda _p: next(readings)):
        for _ in range(200):
            if tripped:
                break
            time.sleep(0.01)
    assert tripped == [50]


def test_the_guard_stops_on_the_first_failed_reading(tmp_path: Path) -> None:
    calls = {"n": 0}

    def flaky(_p: Path) -> int:
        calls["n"] += 1
        if calls["n"] == 2:
            raise OSError("gone")
        return 500

    tripped: list[int] = []
    with cli.DiskGuard(tmp_path, 100, tripped.append, interval=0.01, free=flaky):
        for _ in range(200):
            if tripped:
                break
            time.sleep(0.01)
    assert tripped == [-1]
    assert calls["n"] == 2


def test_the_guard_checks_before_anything_is_downloaded(tmp_path: Path) -> None:
    def broken(_p: Path) -> int:
        raise OSError("statvfs failed")

    with (
        pytest.raises(RuntimeError, match="reserve"),
        cli.DiskGuard(tmp_path, 100, print, free=lambda _p: 50),
    ):
        pass
    with pytest.raises(OSError), cli.DiskGuard(tmp_path, 100, print, free=broken):
        pass


def test_a_single_runtime_reading_failure_stops_the_download(tmp_path: Path) -> None:
    calls = {"n": 0}

    def failing(_p: Path) -> int:
        calls["n"] += 1
        if calls["n"] == 1:
            return 500
        raise OSError("gone")

    tripped: list[int] = []
    with cli.DiskGuard(tmp_path, 100, tripped.append, interval=0.01, free=failing):
        for _ in range(300):
            if tripped:
                break
            time.sleep(0.01)
    assert tripped == [-1]
    assert calls["n"] == 2


def test_a_key_in_the_environment_is_never_printed(
    cli_env: Path, monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    monkeypatch.setenv("MEDIA_API_KEY", API_KEY)
    assert cli.main(["check", "--json"]) == 0
    assert cli.main(["fetch", "nope", "--json"]) == 1
    assert API_KEY not in capsys.readouterr().out
