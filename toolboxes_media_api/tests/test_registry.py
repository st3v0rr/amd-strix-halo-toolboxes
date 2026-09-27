from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest
import yaml

from media_api.errors import CapabilityError, ConfigError
from media_api.registry import _default_model_data, load_registry


def test_default_registry_is_valid():
    registry = load_registry()
    assert {m.id for m in registry.models} == {"qwen-image-2512", "qwen-image-edit-2511", "minimax-h3"}
    for model in registry.models:
        assert model.profile(None).usable
        for profile in model.profiles:
            if profile.lora:
                assert profile.lora.base_model == model.id


def _with_lora(model_id: str, lora_file: str, base_model: str) -> list:
    data = copy.deepcopy(_default_model_data())
    model = next(m for m in data if m["id"] == model_id)
    profile = next(p for p in model["profiles"] if p.get("lora"))
    profile["lora"]["base_model"] = base_model
    profile["lora"]["file"]["path"] = f"loras/{lora_file}"
    profile["lora"]["file"]["filename"] = lora_file
    return [model]


def test_edit_lora_is_never_paired_with_text_to_image():
    bad = _with_lora(
        "qwen-image-2512", "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors", "qwen-image-2512"
    )
    with pytest.raises(ConfigError, match="Edit LoRA"):
        load_registry(bad, include_defaults=False)


def test_lora_base_must_match_model():
    bad = _with_lora(
        "qwen-image-2512", "Qwen-Image-2512-Lightning-4steps-V1.0-bf16.safetensors", "qwen-image-edit-2511"
    )
    with pytest.raises(ConfigError, match="declared for"):
        load_registry(bad, include_defaults=False)


@pytest.mark.parametrize("path", ["/etc/passwd", "../outside.safetensors", "a/../../b", "~/x"])
def test_paths_must_stay_inside_models_dir(path):
    data = copy.deepcopy(_default_model_data())
    data[0]["profiles"][0]["components"]["transformer"]["file"]["path"] = path
    with pytest.raises(ConfigError, match="relative path"):
        load_registry([data[0]], include_defaults=False)


def test_revisions_must_be_pinned_commits():
    data = copy.deepcopy(_default_model_data())
    data[0]["base"]["revision"] = "main"
    with pytest.raises(ConfigError, match="40-character"):
        load_registry([data[0]], include_defaults=False)


def test_task_and_profile_compatibility():
    registry = load_registry()
    model, profile = registry.resolve("text-to-image", None, None)
    assert (model.id, profile.id) == ("qwen-image-2512", "fp8")
    with pytest.raises(CapabilityError, match="does not support 'image-edit'"):
        registry.resolve("image-edit", "qwen-image-2512", None)
    with pytest.raises(CapabilityError, match="cannot run"):
        registry.resolve("text-to-image", "qwen-image-2512", "nf4-bitsandbytes")
    with pytest.raises(CapabilityError, match="cannot run"):
        registry.resolve("text-to-video", "minimax-h3", "comfy-pruned-int8-convrot")
    with pytest.raises(CapabilityError, match="does not support 'reference-to-video'"):
        registry.resolve("reference-to-video", "minimax-h3", "turbo")
    with pytest.raises(CapabilityError) as exc:
        registry.resolve("text-to-image", "nope", None)
    assert exc.value.code == "unknown_model"


def test_missing_files_follow_the_task(tmp_path: Path):
    registry = load_registry()
    h3 = registry.get("minimax-h3")
    profile = h3.profile("int8")
    t2v = set(h3.missing_files(profile, "text-to-video", tmp_path))
    r2v = set(h3.missing_files(profile, "reference-to-video", tmp_path))
    assert any("/transformer/*" in m for m in t2v) and not any("transformer_ref" in m for m in t2v)
    assert any("transformer_ref/*" in m for m in r2v) and not any("/transformer/*" in m for m in r2v)
    base = tmp_path / "diffusers/MiniMax-H3"
    for scheduler in ("scheduler", "audio_scheduler"):
        (base / scheduler).mkdir(parents=True)
        (base / scheduler / "scheduler_config.json").write_text("{}")
    (base / "tokenizer").mkdir()
    (base / "tokenizer/tokenizer_config.json").write_text("{}")
    (base / "tokenizer/tokenizer.json").write_text("{}")
    (base / "processor").mkdir()
    (base / "processor/processor_config.json").write_text("{}")
    for component in ("transformer", "text_encoder", "vae", "audio_vae"):
        (base / component).mkdir()
        (base / component / "config.json").write_text("{}")
        (base / component / "model.safetensors").write_bytes(b"")
    (base / "modular_model_index.json").write_text("{}")
    assert h3.missing_files(profile, "text-to-video", tmp_path) == []


def test_missing_files_reject_incomplete_diffusers_components(tmp_path: Path):
    registry = load_registry()
    h3 = registry.get("minimax-h3")
    profile = h3.profile("int8")
    base = tmp_path / "diffusers/MiniMax-H3"
    for path in (
        "modular_model_index.json",
        "scheduler/scheduler_config.json",
        "audio_scheduler/scheduler_config.json",
        "tokenizer/tokenizer_config.json",
        "processor/processor_config.json",
        "transformer/config.json",
        "text_encoder/config.json",
        "vae/config.json",
        "audio_vae/config.json",
    ):
        (base / path).parent.mkdir(parents=True, exist_ok=True)
        (base / path).write_text("{}")

    missing = h3.missing_files(profile, "text-to-video", tmp_path)
    assert "diffusers/MiniMax-H3/tokenizer/tokenizer assets" in missing
    assert "diffusers/MiniMax-H3/transformer/*.safetensors" in missing
    assert "diffusers/MiniMax-H3/text_encoder/*.safetensors" in missing
    assert "diffusers/MiniMax-H3/vae/*.safetensors" in missing
    assert "diffusers/MiniMax-H3/audio_vae/*.safetensors" in missing


def test_missing_files_reports_every_index_referenced_shard(tmp_path: Path):
    registry = load_registry()
    h3 = registry.get("minimax-h3")
    profile = h3.profile("int8")
    base = tmp_path / "diffusers/MiniMax-H3"
    for scheduler in ("scheduler", "audio_scheduler"):
        (base / scheduler).mkdir(parents=True)
        (base / scheduler / "scheduler_config.json").write_text("{}")
    for directory, config in (("tokenizer", "tokenizer_config.json"), ("processor", "processor_config.json")):
        (base / directory).mkdir()
        (base / directory / config).write_text("{}")
    (base / "tokenizer/tokenizer.json").write_text("{}")
    for component in ("transformer", "text_encoder", "vae", "audio_vae"):
        (base / component).mkdir()
        (base / component / "config.json").write_text("{}")
        (base / component / "model.safetensors").write_bytes(b"")
    (base / "modular_model_index.json").write_text("{}")
    transformer = base / "transformer"
    (transformer / "model.safetensors").unlink()
    (transformer / "model-00001-of-00002.safetensors").write_bytes(b"")
    index = {
        "weight_map": {
            "block.0": "model-00001-of-00002.safetensors",
            "block.1": "model-00002-of-00002.safetensors",
        }
    }
    (transformer / "model.safetensors.index.json").write_text(json.dumps(index))

    assert h3.missing_files(profile, "text-to-video", tmp_path) == [
        "diffusers/MiniMax-H3/transformer/model-00002-of-00002.safetensors"
    ]


def test_user_config_can_replace_a_model(tmp_path: Path):
    data = copy.deepcopy(_default_model_data())
    data[0]["label"] = "Custom label"
    registry = load_registry(yaml.safe_load(yaml.safe_dump([data[0]])))
    assert registry.get("qwen-image-2512").label == "Custom label"
    assert len(registry.models) == 3
