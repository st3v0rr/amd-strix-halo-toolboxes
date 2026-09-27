"""The real adapters, on CPU, without downloading a single model weight.

- Key mappings are checked against the headers of the real checkpoints
  (fixtures/checkpoint_keys.json.gz: names, dtypes and shapes of the pinned
  files, no weights).
- The loaders are checked numerically on tiny random models written in the
  exact Comfy layouts those headers show.
- With MEDIA_TEST_TINY_H3 pointing at diffusers' own random-weight test repo
  (hf-internal-testing/tiny-minimax-h3-modular-pipe, 44 MB), both providers
  run end to end through their real diffusers pipelines.

Skipped entirely when torch/diffusers/transformers are not installed.
"""

from __future__ import annotations

import gzip
import json
import os
import shutil
from pathlib import Path

import pytest

torch = pytest.importorskip("torch")
pytest.importorskip("diffusers")
pytest.importorskip("transformers")

import av
from accelerate import init_empty_weights
from diffusers import (
    AutoencoderKLQwenImage,
    FlowMatchEulerDiscreteScheduler,
    MiniMaxH3ModularPipeline,
    MiniMaxH3Transformer3DModel,
    QwenImagePipeline,
    QwenImageTransformer2DModel,
)
from safetensors.torch import save_file
from transformers import (
    Qwen2_5_VLConfig,
    Qwen2_5_VLForConditionalGeneration,
    Qwen3VLConfig,
    Qwen3VLForConditionalGeneration,
)

from media_api.config import load_settings
from media_api.providers.base import GenerationRequest
from media_api.providers.loaders import (
    COMFY_PREFIX,
    TensorSource,
    legacy_qwen25vl_name,
    load_streaming,
    lora_deltas,
    meta_model,
)
from media_api.providers.quant import FP8, WeightOnlyLinear, quantize

from .conftest import API_KEY

FIXTURE = Path(__file__).parent / "fixtures" / "checkpoint_keys.json.gz"
TINY_H3 = os.environ.get("MEDIA_TEST_TINY_H3")
needs_tiny = pytest.mark.skipif(
    not TINY_H3 or not Path(TINY_H3, "transformer").is_dir(), reason="set MEDIA_TEST_TINY_H3"
)


@pytest.fixture(scope="module")
def real():
    with gzip.open(FIXTURE, "rt") as handle:
        return json.load(handle)


def keys_of(factory):
    with init_empty_weights():
        return dict(factory().state_dict())


def linears_of(factory):
    with init_empty_weights():
        return {n for n, m in factory().named_modules() if isinstance(m, torch.nn.Linear)}


# -- key mappings against the real files ------------------------------------


def test_comfy_qwen_files_map_onto_diffusers_and_transformers(real):
    ck, cfg = real["checkpoints"], real["configs"]
    t2i = lambda: QwenImageTransformer2DModel.from_config(cfg["qwen-image-2512/transformer"])
    fp8 = ck["comfy/qwen_image_2512_fp8_e4m3fn"]
    assert {k.removeprefix(COMFY_PREFIX) for k in fp8} == set(keys_of(t2i))
    assert {v[0] for v in fp8.values()} == {"F8_E4M3"}  # plain cast: no scales anywhere

    edit = ck["comfy/qwen_image_edit_2511_fp8mixed"]
    core = {
        k
        for k in edit
        if not k.endswith((".comfy_quant", ".weight_scale", ".input_scale")) and not k.startswith("__")
    }
    edit_model = lambda: QwenImageTransformer2DModel.from_config(cfg["qwen-image-edit-2511/transformer"])
    assert core == set(keys_of(edit_model))
    scaled = {k.removesuffix(".weight_scale") for k in edit if k.endswith(".weight_scale")}
    assert scaled and scaled <= linears_of(edit_model)
    assert any(v[0] == "BF16" and k.endswith(".weight") for k, v in edit.items())  # really mixed

    te = ck["comfy/qwen_2.5_vl_7b_fp8_scaled"]
    te_model = lambda: Qwen2_5_VLForConditionalGeneration(
        Qwen2_5_VLConfig.from_dict(cfg["qwen-image-2512/text_encoder"])
    )
    mapped = {
        legacy_qwen25vl_name(k)
        for k in te
        if not k.endswith((".scale_weight", ".scale_input")) and k != "scaled_fp8"
    }
    assert mapped == set(keys_of(te_model))
    scaled = {
        legacy_qwen25vl_name(k.removesuffix(".scale_weight")) for k in te if k.endswith(".scale_weight")
    }
    assert scaled <= linears_of(te_model)


def test_minimax_h3_diffusers_weights_match_and_comfy_pruned_does_not(real):
    ck, cfg = real["checkpoints"], real["configs"]
    h3 = keys_of(lambda: MiniMaxH3Transformer3DModel.from_config(cfg["minimax-h3/transformer"]))
    assert set(ck["diffusers/MiniMax-H3/transformer"]) == set(h3)
    te = keys_of(
        lambda: Qwen3VLForConditionalGeneration(Qwen3VLConfig.from_dict(cfg["minimax-h3/text_encoder"]))
    )
    assert set(ck["diffusers/MiniMax-H3/text_encoder"]) == set(te)
    # Why the Comfy pruned files are refused: an architecture diffusers does not have.
    pruned = ck["comfy/minimax_h3_fl2va_pruned_int8_convrot"]
    assert "adaln_t_table" in pruned and "adaln_t_table" not in h3
    assert pruned["blocks.0.adaln_proj.linear.weight"][1][1] == 8
    assert pruned["blocks.0.attn.qkv_proj.weight"][0] == "I8"


@pytest.mark.parametrize(
    ("lora", "loader", "factory_cfg", "factory"),
    [
        (
            "lora/Qwen-Image-2512-Lightning-4steps-V1.0-bf16",
            QwenImagePipeline,
            "qwen-image-2512/transformer",
            QwenImageTransformer2DModel,
        ),
        (
            "lora/minimax_h3_turbo_v4_step600_ema",
            MiniMaxH3ModularPipeline,
            "minimax-h3/transformer",
            MiniMaxH3Transformer3DModel,
        ),
    ],
)
def test_real_lora_layouts_land_on_existing_linears(real, lora, loader, factory_cfg, factory):
    layout = real["checkpoints"][lora]
    state = {k: torch.zeros(shape, dtype=torch.bfloat16) for k, (_, shape) in layout.items()}
    deltas = lora_deltas(loader.lora_state_dict(state), "transformer.", 1.0)
    linears = linears_of(lambda: factory.from_config(real["configs"][factory_cfg]))
    assert deltas and set(deltas) <= linears


# -- quantized linear and streaming loader ------------------------------------


@pytest.mark.parametrize(("qdtype", "tolerance"), [(torch.int8, 0.02), (FP8, 0.08)])
def test_weight_only_linear_tracks_dense(qdtype, tolerance):
    torch.manual_seed(0)
    weight, x = torch.randn(64, 48) * 0.05, torch.randn(8, 48)
    q, scale = quantize(weight, qdtype, per_row=True)
    layer = WeightOnlyLinear(48, 64, False, qdtype, torch.float32, True)
    layer._buffers["qweight"], layer._buffers["scale"] = q, scale
    reference = x @ weight.T
    assert ((layer(x) - reference).norm() / reference.norm()).item() < tolerance


def tiny_qwen_transformer():
    torch.manual_seed(0)
    return QwenImageTransformer2DModel(
        patch_size=2,
        in_channels=16,
        out_channels=4,
        num_layers=2,
        attention_head_dim=16,
        num_attention_heads=3,
        joint_attention_dim=16,
        guidance_embeds=False,
        axes_dims_rope=(8, 4, 4),
    )


def tiny_qwen_text_encoder():
    torch.manual_seed(0)
    config = Qwen2_5_VLConfig(
        text_config={
            "hidden_size": 16,
            "intermediate_size": 16,
            "num_hidden_layers": 2,
            "num_attention_heads": 2,
            "num_key_value_heads": 2,
            "rope_theta": 1000000.0,
            "rope_scaling": {"mrope_section": [1, 1, 2], "rope_type": "default", "type": "default"},
        },
        vision_config={
            "depth": 2,
            "hidden_size": 16,
            "intermediate_size": 16,
            "num_heads": 2,
            "out_hidden_size": 16,
        },
        hidden_size=16,
        vocab_size=152064,
        vision_end_token_id=151653,
        vision_start_token_id=151652,
        vision_token_id=151654,
    )
    return Qwen2_5_VLForConditionalGeneration(config).eval()


def comfy_scaled(state, linears, legacy_scale_names=False, keep_dense=()):
    """Write `state` the way Comfy's scaled FP8 files do (see the headers in the fixture)."""
    out = {}
    for name, value in state.items():
        module = name.rsplit(".", 1)[0]
        if name.endswith(".weight") and module in linears and module not in keep_dense:
            q, scale = quantize(value.float(), FP8, per_row=False)
            out[name] = q
            if legacy_scale_names:
                out[f"{module}.scale_weight"], out[f"{module}.scale_input"] = (
                    scale.reshape(()),
                    torch.ones(()),
                )
            else:
                out[f"{module}.weight_scale"], out[f"{module}.input_scale"] = (
                    scale.reshape(()),
                    torch.ones(()),
                )
                out[f"{module}.comfy_quant"] = torch.tensor(
                    list(b'{"format": "float8_e4m3fn"}'), dtype=torch.uint8
                )
        else:
            out[name] = value.to(torch.bfloat16)
    out["scaled_fp8" if legacy_scale_names else "__index_timestep_zero__"] = torch.zeros(
        0, dtype=FP8 if legacy_scale_names else torch.float32
    )
    return out


def dense_weights(model):
    return {
        n: m.dequantize(torch.float32) if isinstance(m, WeightOnlyLinear) else m.weight.float()
        for n, m in model.named_modules()
        if isinstance(m, (WeightOnlyLinear, torch.nn.Linear))
    }


def test_plain_fp8_single_file_stays_bit_exact(tmp_path):
    state = {COMFY_PREFIX + k: v.to(FP8) for k, v in tiny_qwen_transformer().state_dict().items()}
    path = tmp_path / "t.safetensors"
    save_file(state, path)
    config = tiny_qwen_transformer().config
    load = lambda storage: load_streaming(
        meta_model(lambda: QwenImageTransformer2DModel.from_config(config)),
        TensorSource([path]),
        device="cpu",
        compute_dtype=torch.bfloat16,
        storage=storage,
        rename=lambda k: k.removeprefix(COMFY_PREFIX),
    )
    fp8, bf16 = load("fp8"), load("bf16")
    quantized = [m for m in fp8.modules() if isinstance(m, WeightOnlyLinear)]
    assert quantized and all(m.qweight.dtype == FP8 and m.scale.dim() == 0 for m in quantized)
    a, b = dense_weights(fp8), dense_weights(bf16)
    assert all(torch.equal(a[n], b[n]) for n in a)


def test_comfy_fp8mixed_and_int8_rowwise(tmp_path):
    model = tiny_qwen_transformer().to(torch.bfloat16)
    linears = {n for n, m in model.named_modules() if isinstance(m, torch.nn.Linear)}
    dense = sorted(linears)[:1]  # like fp8mixed: some layers stay BF16
    state = comfy_scaled(model.state_dict(), linears, keep_dense=dense)
    path = tmp_path / "mixed.safetensors"
    save_file(state, path)
    loaded = load_streaming(
        meta_model(lambda: QwenImageTransformer2DModel.from_config(model.config)),
        TensorSource([path]),
        device="cpu",
        compute_dtype=torch.bfloat16,
        storage="fp8",
    )
    got = dense_weights(loaded)
    for name in linears:
        module = name
        expected = state[f"{module}.weight"].float()
        if f"{module}.weight_scale" in state:
            expected = expected * state[f"{module}.weight_scale"]
        assert torch.allclose(got[name], expected, rtol=1e-2, atol=1e-3), name
    assert isinstance(loaded.get_submodule(dense[0]), torch.nn.Linear)

    bf16_path = tmp_path / "bf16.safetensors"
    save_file({k: v.contiguous() for k, v in model.state_dict().items()}, bf16_path)
    int8 = load_streaming(
        meta_model(lambda: QwenImageTransformer2DModel.from_config(model.config)),
        TensorSource([bf16_path]),
        device="cpu",
        compute_dtype=torch.bfloat16,
        storage="int8",
        exclude=("proj_out",),
    )
    assert isinstance(int8.get_submodule("proj_out"), torch.nn.Linear)
    reference = dense_weights(model)
    for name, weight in dense_weights(int8).items():
        assert ((weight - reference[name]).norm() / reference[name].norm()).item() < 0.02, name


def test_legacy_qwen25vl_scaled_text_encoder_matches_reference(tmp_path):
    model = tiny_qwen_text_encoder()
    linears = {n for n, m in model.named_modules() if isinstance(m, torch.nn.Linear) and n != "lm_head"}
    inverse = {
        legacy_qwen25vl_name(k): k
        for k in [
            "model." + k.split("model.language_model.", 1)[1]
            if k.startswith("model.language_model.")
            else "visual." + k.split("model.visual.", 1)[1]
            if k.startswith("model.visual.")
            else k
            for k in model.state_dict()
        ]
    }
    legacy_state = {inverse[k]: v for k, v in model.state_dict().items()}
    state = comfy_scaled(
        legacy_state, {inverse[f"{n}.weight"].rsplit(".", 1)[0] for n in linears}, legacy_scale_names=True
    )
    path = tmp_path / "te.safetensors"
    save_file(state, path)
    loaded = load_streaming(
        meta_model(lambda: Qwen2_5_VLForConditionalGeneration(model.config)),
        TensorSource([path]),
        device="cpu",
        compute_dtype=torch.float32,
        storage="fp8",
        rename=legacy_qwen25vl_name,
        skip=("lm_head",),
    )
    assert isinstance(loaded.lm_head, torch.nn.Identity)
    with torch.no_grad():  # reference: the original model holding exactly what the file holds
        for param in model.parameters():  # the file keeps everything but the FP8 layers in BF16
            param.copy_(param.to(torch.bfloat16).float())
        for name in linears:
            module = model.get_submodule(name)
            legacy = inverse[f"{name}.weight"].rsplit(".", 1)[0]
            module.weight.copy_(state[f"{legacy}.weight"].float() * state[f"{legacy}.scale_weight"])
        ids = torch.tensor([[1, 5, 9, 200, 3000]])
        want = model(input_ids=ids, output_hidden_states=True).hidden_states[-1]
        got = loaded(input_ids=ids, output_hidden_states=True).hidden_states[-1]
    assert torch.allclose(got, want, rtol=1e-4, atol=1e-4)


def test_lora_fusion_matches_peft(tmp_path):
    model = tiny_qwen_transformer()
    targets = ["transformer_blocks.0.attn.to_q", "transformer_blocks.1.img_mlp.net.2"]
    torch.manual_seed(1)
    lora = {}
    for target in targets:  # lightx2v's layout: lora_down / lora_up / alpha under diffusers names
        module = model.get_submodule(target)
        lora[f"{target}.lora_down.weight"] = torch.randn(4, module.in_features) * 0.1
        lora[f"{target}.lora_up.weight"] = torch.randn(module.out_features, 4) * 0.1
        lora[f"{target}.alpha"] = torch.tensor(2.0)
    converted = QwenImagePipeline.lora_state_dict(dict(lora))
    path = tmp_path / "base.safetensors"
    save_file({k: v.contiguous() for k, v in model.state_dict().items()}, path)
    fused = load_streaming(
        meta_model(lambda: QwenImageTransformer2DModel.from_config(model.config)),
        TensorSource([path]),
        device="cpu",
        compute_dtype=torch.float32,
        storage="fp32",
        deltas=lora_deltas(converted, "transformer.", 1.0),
    )
    reference = tiny_qwen_transformer()
    reference.load_lora_adapter(
        QwenImagePipeline.lora_state_dict(dict(lora)), prefix="transformer", adapter_name="t"
    )
    for target in targets:
        x = torch.randn(3, model.get_submodule(target).in_features)
        assert torch.allclose(fused.get_submodule(target)(x), reference.get_submodule(target)(x), atol=1e-5)


# -- end to end through the providers ------------------------------------------


class Ctx:
    cancelled = False

    def __init__(self):
        self.stages = []

    def report(self, stage, progress=None):
        self.stages.append(stage)

    def check_cancelled(self):
        pass


def settings_for(models_dir: Path):
    return load_settings(
        {
            "MEDIA_API_KEY": API_KEY,
            "MEDIA_BACKEND": "real",
            "MEDIA_DEVICE": "cpu",
            "MEDIA_MODELS_DIR": str(models_dir),
            "MEDIA_OUTPUT_DIR": str(models_dir / "out"),
            "MEDIA_UPLOAD_DIR": str(models_dir / "up"),
            "MEDIA_STATE_DIR": str(models_dir / "state"),
        }
    )


@needs_tiny
def test_qwen_text_to_image_provider_end_to_end(tmp_path):
    from media_api.providers.qwen_image import QwenImageProvider

    base = tmp_path / "diffusers" / "Qwen-Image-2512"
    transformer, te = tiny_qwen_transformer(), tiny_qwen_text_encoder()
    (base / "transformer").mkdir(parents=True)
    transformer.save_config(base / "transformer")
    te.config.save_pretrained(base / "text_encoder")
    torch.manual_seed(0)
    AutoencoderKLQwenImage(
        base_dim=24,
        z_dim=4,
        dim_mult=[1, 2, 4],
        num_res_blocks=1,
        temperal_downsample=[False, True],
        latents_mean=[0.0] * 4,
        latents_std=[1.0] * 4,
    ).save_pretrained(base / "vae")
    FlowMatchEulerDiscreteScheduler().save_pretrained(base / "scheduler")
    shutil.copytree(Path(TINY_H3) / "tokenizer", base / "tokenizer")
    (tmp_path / "diffusion_models").mkdir()
    save_file(
        {COMFY_PREFIX + k: v.to(FP8) for k, v in transformer.state_dict().items()},
        tmp_path / "diffusion_models" / "qwen_image_2512_fp8_e4m3fn.safetensors",
    )
    linears = {n for n, m in te.named_modules() if isinstance(m, torch.nn.Linear) and n != "lm_head"}
    legacy = {
        ("model." + k.split("model.language_model.", 1)[1])
        if k.startswith("model.language_model.")
        else ("visual." + k.split("model.visual.", 1)[1])
        if k.startswith("model.visual.")
        else k: v
        for k, v in te.state_dict().items()
    }
    names = {
        ("model." + n.split("model.language_model.", 1)[1])
        if n.startswith("model.language_model.")
        else ("visual." + n.split("model.visual.", 1)[1])
        for n in linears
    }
    (tmp_path / "text_encoders").mkdir()
    save_file(
        comfy_scaled(legacy, names, legacy_scale_names=True),
        tmp_path / "text_encoders" / "qwen_2.5_vl_7b_fp8_scaled.safetensors",
    )

    settings = settings_for(tmp_path)
    model = settings.registry.get("qwen-image-2512")
    profile = model.profile("fp8")
    provider = QwenImageProvider(settings, model, profile)
    ctx = Ctx()
    provider.load(ctx)
    out = tmp_path / "out"
    out.mkdir(exist_ok=True)
    request = GenerationRequest(
        task="text-to-image",
        prompt="a red fox",
        negative_prompt=" ",
        width=32,
        height=32,
        steps=2,
        guidance=1.0,
        seed=7,
        output_format="png",
        output_dir=out,
    )
    artifact = provider.generate(request, ctx)
    first = artifact.path.read_bytes()
    assert artifact.content_type == "image/png" and (artifact.width, artifact.height) == (32, 32)
    assert provider.generate(request, ctx).path.read_bytes() == first  # seeded, deterministic
    assert "generating" in ctx.stages


@needs_tiny
def test_minimax_h3_provider_end_to_end_and_partition_swap(tmp_path):
    from media_api.providers.minimax_h3 import MiniMaxH3Provider

    (tmp_path / "diffusers").mkdir()
    (tmp_path / "diffusers" / "MiniMax-H3").symlink_to(Path(TINY_H3).resolve())
    settings = settings_for(tmp_path)
    model = settings.registry.get("minimax-h3")
    provider = MiniMaxH3Provider(settings, model, model.profile("int8"))
    ctx = Ctx()
    provider.load(ctx)
    out = tmp_path / "out"
    out.mkdir(exist_ok=True)
    image = tmp_path / "ref.png"
    from PIL import Image

    Image.new("RGB", (48, 80), (200, 40, 40)).save(image)
    for task, extra in [
        ("text-to-video", {}),
        ("image-to-video", {"start_image": image}),
        ("reference-to-video", {"reference_images": (image,)}),
    ]:
        request = GenerationRequest(
            task=task,
            prompt="a robot dancing",
            negative_prompt=None,
            width=32,
            height=32,
            steps=1,
            guidance=None,
            seed=3,
            output_format="mp4",
            output_dir=out,
            num_frames=124,
            fps=24,
            **extra,
        )
        artifact = provider.generate(request, ctx)
        assert artifact.frames == 124 and artifact.has_audio
        with av.open(str(artifact.path)) as container:
            assert {s.type for s in container.streams} == {"video", "audio"}
        quantized = [
            m for m in getattr(provider.pipe, provider.partition).modules() if isinstance(m, WeightOnlyLinear)
        ]
        assert quantized and all(m.qweight.dtype == torch.int8 for m in quantized)
    assert provider.partition == "transformer_ref" and provider.pipe.transformer is None
