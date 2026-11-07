"""`media-api-models remove`: only a profile's own files, never a shared one, never outside the tree."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from media_api import cli
from media_api.removal import _short_hash

QWEN = "diffusers/Qwen-Image-2512"
QWEN_BASE = (
    "model_index.json",
    "scheduler/scheduler_config.json",
    "tokenizer/tokenizer_config.json",
    "tokenizer/tokenizer.json",
    "vae/config.json",
    "vae/diffusion_pytorch_model.safetensors",
    "transformer/config.json",
    "text_encoder/config.json",
)
EDIT = "diffusers/Qwen-Image-Edit-2511"
QWEN_FP8 = "diffusion_models/qwen_image_2512_fp8_e4m3fn.safetensors"
TE_FP8 = "text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors"
EDIT_FP8 = "diffusion_models/qwen_image_edit_2511_fp8mixed.safetensors"
LORA = "loras/Qwen-Image-2512-Lightning-4steps-V1.0-bf16.safetensors"
H3 = "diffusers/MiniMax-H3"


def _touch(root: Path, rel: str, data: bytes = b"x") -> None:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def _qwen_fp8(root: Path) -> None:
    for rel in QWEN_BASE:
        _touch(root, f"{QWEN}/{rel}")
    _touch(root, QWEN_FP8, b"t" * 1000)
    _touch(root, TE_FP8, b"e" * 500)


def _edit_fp8mixed(root: Path) -> None:
    for rel in (*QWEN_BASE, "processor/processor_config.json"):
        _touch(root, f"{EDIT}/{rel}")
    _touch(root, EDIT_FP8)
    _touch(root, TE_FP8, b"e" * 500)


def _h3(root: Path, components: tuple[str, ...]) -> None:
    for rel in (
        "modular_model_index.json",
        "scheduler/scheduler_config.json",
        "audio_scheduler/scheduler_config.json",
        "tokenizer/tokenizer_config.json",
        "tokenizer/tokenizer.json",
        "processor/processor_config.json",
    ):
        _touch(root, f"{H3}/{rel}")
    for component in components:
        _touch(root, f"{H3}/{component}/config.json")
        _touch(root, f"{H3}/{component}/model.safetensors", b"w" * 10)


def _remove(capsys, *args: str) -> dict:
    assert cli.main(["remove", *args, "--json"]) == 0
    return json.loads(capsys.readouterr().out)


def _profiles(capsys) -> dict[str, dict]:
    assert cli.main(["check", "--json"]) == 0
    doc = json.loads(capsys.readouterr().out)
    return {f"{m['id']}/{p['id']}": p for m in doc["models"] for p in m["profiles"]}


def test_a_profile_alone_goes_entirely_with_its_hub_bookkeeping(cli_env: Path, capsys) -> None:
    _qwen_fp8(cli_env)
    _touch(cli_env, f"{QWEN}/.cache/huggingface/.gitignore")
    _touch(cli_env, f"{QWEN}/.cache/huggingface/download/vae/config.json.metadata")
    _touch(cli_env, f"{QWEN}/transformer/diffusion_pytorch_model-00001.safetensors")  # not the profile's
    doc = _remove(capsys, "qwen-image-2512", "--profile", "fp8")
    assert doc["version"] == 1 and doc["dry_run"] is False
    assert set(doc["files"]) == {QWEN_FP8, TE_FP8, *(f"{QWEN}/{rel}" for rel in QWEN_BASE)}
    assert f"{QWEN}/.cache/huggingface/download/vae/config.json.metadata" in doc["partials"]
    assert doc["kept"] == [] and doc["skipped"] == []
    assert doc["bytes"] >= 1500
    assert not (cli_env / QWEN_FP8).exists() and not (cli_env / TE_FP8).exists()
    assert not (cli_env / QWEN / ".cache").exists() and not (cli_env / QWEN / "vae").exists()
    # A file the registry does not attribute to the profile stays, and so does its directory.
    assert (cli_env / QWEN / "transformer/diffusion_pytorch_model-00001.safetensors").is_file()
    # Role directories are the tree's layout, not the profile's: they stay.
    assert (cli_env / "diffusion_models").is_dir()
    assert _profiles(capsys)["qwen-image-2512/fp8"]["removable"] is False


def test_files_another_complete_profile_uses_stay(cli_env: Path, capsys) -> None:
    _qwen_fp8(cli_env)
    _touch(cli_env, LORA, b"l" * 100)
    profiles = _profiles(capsys)
    # fp8 is a subset of Lightning: nothing of it can go while Lightning is there.
    fp8 = profiles["qwen-image-2512/fp8"]
    assert fp8["removable"] is False and fp8["shared_with"] == ["qwen-image-2512/lightning-4step"]
    lightning = profiles["qwen-image-2512/lightning-4step"]
    assert lightning["removable"] is True and lightning["removable_bytes"] == 100

    doc = _remove(capsys, "qwen-image-2512", "--profile", "lightning-4step")
    assert doc["files"] == [LORA] and doc["bytes"] == 100
    kept = {k["path"]: k["used_by"] for k in doc["kept"]}
    assert kept[QWEN_FP8] == ["qwen-image-2512/fp8"]
    assert (cli_env / QWEN_FP8).is_file() and (cli_env / f"{QWEN}/model_index.json").is_file()
    assert _profiles(capsys)["qwen-image-2512/fp8"]["available"] is True


def test_a_text_encoder_shared_across_models_stays(cli_env: Path, capsys) -> None:
    _qwen_fp8(cli_env)
    _edit_fp8mixed(cli_env)
    doc = _remove(capsys, "qwen-image-2512", "--profile", "fp8")
    assert QWEN_FP8 in doc["files"] and TE_FP8 not in doc["files"]
    assert {k["path"]: k["used_by"] for k in doc["kept"]}[TE_FP8] == ["qwen-image-edit-2511/fp8mixed"]
    assert (cli_env / TE_FP8).is_file()
    assert _profiles(capsys)["qwen-image-edit-2511/fp8mixed"]["available"] is True


def test_a_partly_downloaded_profile_protects_nothing(cli_env: Path, capsys) -> None:
    # Lightning without its LoRA is not usable for anything, so fp8 can go whole.
    _qwen_fp8(cli_env)
    doc = _remove(capsys, "qwen-image-2512", "--profile", "fp8")
    assert QWEN_FP8 in doc["files"] and doc["kept"] == []


def test_dry_run_touches_nothing(cli_env: Path, capsys) -> None:
    _qwen_fp8(cli_env)
    before = sorted(p.relative_to(cli_env).as_posix() for p in cli_env.rglob("*"))
    doc = _remove(capsys, "qwen-image-2512", "--profile", "fp8", "--dry-run")
    assert doc["dry_run"] is True and QWEN_FP8 in doc["files"]
    assert sorted(p.relative_to(cli_env).as_posix() for p in cli_env.rglob("*")) == before


def test_stage_leftovers_of_the_profiles_files_go_and_no_others(cli_env: Path, capsys) -> None:
    _qwen_fp8(cli_env)
    name = "split_files/diffusion_models/qwen_image_2512_fp8_e4m3fn.safetensors"
    other = "split_files/diffusion_models/qwen_image_edit_2511_bf16.safetensors"
    download = ".stage/.cache/huggingface/download"
    ours = [
        f"{download}/{name}.metadata",
        f"{download}/{name}.lock",
        f"{download}/split_files/diffusion_models/"
        f"{_short_hash('qwen_image_2512_fp8_e4m3fn.safetensors.metadata')}.etag1.incomplete",
    ]
    theirs = [
        f"{download}/{other}.lock",
        f"{download}/split_files/diffusion_models/"
        f"{_short_hash('qwen_image_edit_2511_bf16.safetensors.metadata')}.etag2.incomplete",
    ]
    for rel in ours + theirs:
        _touch(cli_env, rel)
    doc = _remove(capsys, "qwen-image-2512", "--profile", "fp8")
    assert set(ours) <= set(doc["partials"])
    assert not set(theirs) & set(doc["partials"])
    for rel in ours:
        assert not (cli_env / rel).exists()
    for rel in theirs:
        assert (cli_env / rel).is_file()


def test_a_shared_snapshot_directory_loses_only_the_profiles_part(cli_env: Path, capsys) -> None:
    # int8 complete for every task including the reference partition; turbo shares the base dir.
    _h3(cli_env, ("transformer", "transformer_ref", "text_encoder", "vae", "audio_vae"))
    _touch(cli_env, "loras/minimax_h3_turbo_v4_step600_ema.safetensors")
    download = f"{H3}/.cache/huggingface/download"
    ref_partial = f"{download}/transformer_ref/{_short_hash('x.safetensors.metadata')}.e.incomplete"
    ref_meta = f"{download}/transformer_ref/model.safetensors.metadata"
    shared_partial = f"{download}/transformer/{_short_hash('y.safetensors.metadata')}.e.incomplete"
    unknown_top = f"{download}/{_short_hash('somewhere.json.metadata')}.e.incomplete"
    for rel in (ref_partial, ref_meta, shared_partial, unknown_top):
        _touch(cli_env, rel)
    doc = _remove(capsys, "minimax-h3", "--profile", "int8")
    files = set(doc["files"])
    # Only the reference partition is int8's alone.
    assert files == {f"{H3}/transformer_ref/config.json", f"{H3}/transformer_ref/model.safetensors"}
    assert set(doc["partials"]) == {ref_partial, ref_meta}
    for rel in (shared_partial, unknown_top, f"{H3}/transformer/model.safetensors"):
        assert (cli_env / rel).is_file()
    assert not (cli_env / H3 / "transformer_ref").exists()
    assert _profiles(capsys)["minimax-h3/turbo"]["available"] is True


def test_nothing_outside_the_tree_is_touched(cli_env: Path, tmp_path: Path, capsys) -> None:
    outside = tmp_path / "elsewhere"
    _touch(outside, "qwen_image_2512_fp8_e4m3fn.safetensors")
    _touch(outside, "te.safetensors")
    _qwen_fp8(cli_env)
    (cli_env / QWEN_FP8).unlink()
    (cli_env / "diffusion_models").rmdir()
    # A role directory that is a link out of the tree, and a file that is one.
    (cli_env / "diffusion_models").symlink_to(outside, target_is_directory=True)
    (cli_env / TE_FP8).unlink()
    (cli_env / TE_FP8).symlink_to(outside / "te.safetensors")
    doc = _remove(capsys, "qwen-image-2512", "--profile", "fp8")
    assert {s["path"]: s["reason"] for s in doc["skipped"]} == {QWEN_FP8: "outside the model tree"}
    # The link inside the tree goes as a link; what it points to stays.
    assert TE_FP8 in doc["files"]
    assert not (cli_env / TE_FP8).is_symlink()
    assert (outside / "te.safetensors").is_file()
    assert (outside / "qwen_image_2512_fp8_e4m3fn.safetensors").is_file()


def test_a_snapshot_directory_that_is_a_link_out_is_skipped(cli_env: Path, tmp_path: Path, capsys) -> None:
    outside = tmp_path / "elsewhere"
    for rel in QWEN_BASE:
        _touch(outside, rel)
    (cli_env / "diffusers").mkdir()
    (cli_env / QWEN).symlink_to(outside, target_is_directory=True)
    doc = _remove(capsys, "qwen-image-2512", "--profile", "fp8")
    assert doc["files"] == [] and doc["partials"] == []
    assert {s["path"]: s["reason"] for s in doc["skipped"]} == {QWEN: "a link; not followed"}
    assert all((outside / rel).is_file() for rel in QWEN_BASE)


def test_remove_errors_are_json_events(cli_env: Path, capsys) -> None:
    assert cli.main(["remove", "nope", "--json"]) == 1
    assert cli.main(["remove", "qwen-image-2512", "--profile", "nope", "--json"]) == 1
    events = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert [e["event"] for e in events] == ["error", "error"]


def test_text_output_lists_what_went(cli_env: Path, capsys) -> None:
    _qwen_fp8(cli_env)
    _touch(cli_env, LORA)
    assert cli.main(["remove", "qwen-image-2512", "--profile", "lightning-4step"]) == 0
    out = capsys.readouterr().out.splitlines()
    assert f"removed {LORA}" in out
    assert any(line.startswith(f"kept {QWEN_FP8}") for line in out)


@pytest.mark.parametrize("profile", ["fp8", "bf16", "lightning-4step"])
def test_an_empty_tree_has_nothing_to_remove(cli_env: Path, capsys, profile: str) -> None:
    doc = _remove(capsys, "qwen-image-2512", "--profile", profile)
    assert doc["files"] == [] and doc["bytes"] == 0
