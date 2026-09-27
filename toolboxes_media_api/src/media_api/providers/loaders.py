"""Checkpoint loading: build the model on the meta device, then stream tensors in.

One tensor at a time goes from disk to its final form on the device — renamed,
upcast, LoRA-fused and quantized on the way — so peak memory stays close to
the finished model instead of a BF16 copy plus the result. Tensors are copied
out of the file mapping (MEDIA_DISABLE_MMAP, on by default: ComfyUI disables
mmap on gfx1151 for the same reason).

The key mappings were checked name for name against the real files' headers
(tests/fixtures/checkpoint_keys.json.gz and tests/test_real_adapters.py):

- Comfy single files carry diffusers names under `model.diffusion_model.`;
  diffusers' from_single_file maps Qwen-Image with an identity function and
  would leave every weight unloaded, so the prefix is stripped here.
- Comfy's scaled FP8 keeps `<layer>.weight` in FP8 plus a per-tensor scale:
  `scale_weight` (older files, with `scale_input` and a `scaled_fp8` marker) or
  `weight_scale` (fp8mixed, with `input_scale` and a `comfy_quant` descriptor).
  weight * scale is the dequantized weight; input scales only matter to FP8
  matmul hardware and are dropped.
- Comfy's Qwen2.5-VL files use the pre-v5 transformers names (`model.layers.*`,
  `visual.*`), which transformers 5 nests under `model.language_model` and
  `model.visual`.
"""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Iterable
from pathlib import Path

import torch
from torch import nn

from .quant import FP8, WeightOnlyLinear, quantize, replace_linears

log = logging.getLogger("media_api.loaders")

DTYPES = {"bf16": torch.bfloat16, "fp16": torch.float16, "fp32": torch.float32}
COMFY_PREFIX = "model.diffusion_model."
_SCALE_SUFFIXES = (".scale_weight", ".weight_scale")
_DROPPED_SUFFIXES = (".scale_input", ".input_scale", ".comfy_quant")
_DROPPED_KEYS = re.compile(r"^(scaled_fp8|__\w+__)$")


class LoadError(RuntimeError):
    pass


class TensorSource:
    """Keys and tensors of one safetensors file or a sharded set."""

    def __init__(self, files: list[Path], disable_mmap: bool = True) -> None:
        from safetensors import safe_open

        self._handles = {}
        self._where: dict[str, Path] = {}
        self._disable_mmap = disable_mmap
        for file in files:
            handle = safe_open(str(file), framework="pt", device="cpu")
            self._handles[file] = handle
            for key in handle.keys():  # noqa: SIM118 - safe_open is not a mapping
                self._where[key] = file
        self.metadata = self._handles[files[0]].metadata() or {} if files else {}

    @classmethod
    def for_dir(cls, directory: Path, disable_mmap: bool = True) -> TensorSource:
        index = sorted(directory.glob("*.safetensors.index.json"))
        if index:
            weight_map = json.loads(index[0].read_text())["weight_map"]
            files = sorted({directory / name for name in weight_map.values()})
        else:
            files = sorted(directory.glob("*.safetensors"))
        if not files:
            raise LoadError(f"no safetensors weights in {directory}")
        return cls(files, disable_mmap)

    def keys(self) -> list[str]:
        return list(self._where)

    def __contains__(self, key: str) -> bool:
        return key in self._where

    def dtype(self, key: str) -> str:
        """The stored dtype (safetensors spelling, e.g. F8_E4M3), read from the header only."""
        return self._handles[self._where[key]].get_slice(key).get_dtype()

    def get(self, key: str) -> torch.Tensor:
        tensor = self._handles[self._where[key]].get_tensor(key)
        return tensor.clone() if self._disable_mmap else tensor

    def close(self) -> None:
        self._handles.clear()


def legacy_qwen25vl_name(key: str) -> str:
    if key.startswith("model."):
        return "model.language_model." + key[len("model.") :]
    if key.startswith("visual."):
        return "model.visual." + key[len("visual.") :]
    return key


def _set(model: nn.Module, name: str, tensor: torch.Tensor) -> None:
    owner_name, _, leaf = name.rpartition(".")
    owner = model.get_submodule(owner_name) if owner_name else model
    if leaf in owner._parameters:
        owner._parameters[leaf] = nn.Parameter(tensor, requires_grad=False)
    elif leaf in owner._buffers:
        owner._buffers[leaf] = tensor
    else:
        raise LoadError(f"checkpoint tensor {name} has no place in {type(model).__name__}")


def lora_deltas(
    state_dict: dict, prefix: str, scale: float
) -> dict[str, tuple[torch.Tensor, torch.Tensor, float]]:
    """Module name → (A, B, factor) from a diffusers-format LoRA state dict."""
    if isinstance(state_dict, tuple):
        state_dict = state_dict[0]
    pairs: dict[str, tuple[torch.Tensor, torch.Tensor, float]] = {}
    for key, down in state_dict.items():
        if not key.startswith(prefix) or ".lora_A." not in key:
            continue
        module = key[len(prefix) :].split(".lora_A.")[0]
        up = state_dict.get(key.replace(".lora_A.", ".lora_B."))
        if up is None:
            raise LoadError(f"LoRA has lora_A without lora_B for {module}")
        alpha = state_dict.get(f"{prefix}{module}.alpha")
        factor = scale * (float(alpha) / down.shape[0] if alpha is not None else 1.0)
        pairs[module] = (down, up, factor)
    if not pairs:
        raise LoadError(f"the LoRA has no weights for '{prefix.rstrip('.')}'")
    return pairs


def load_streaming(
    model: nn.Module,
    source: TensorSource,
    *,
    device: torch.device | str,
    compute_dtype: torch.dtype,
    storage: str,
    rename=lambda key: key,
    exclude: Iterable[str] = (),
    skip: Iterable[str] = (),
    deltas: dict | None = None,
    scale_key_suffixes: tuple[str, ...] = _SCALE_SUFFIXES,
) -> nn.Module:
    """Fill a meta-device `model` from `source`.

    storage: bf16/fp16/fp32 → dense; fp8 → FP8 weight-only (a stored FP8 weight
    is kept bit-exact with its own scale, or scale 1 when the file has none;
    anything else is quantized per row); int8 → INT8 per row. `exclude` lists
    module-name prefixes that stay dense; `skip` lists modules not loaded at all.
    """
    deltas = dict(deltas or {})
    skip = tuple(skip)
    exclude = tuple(exclude)
    names = {}  # model name -> checkpoint key
    scales = {}
    for key in source.keys():  # noqa: SIM118 - TensorSource is not iterable
        if key.endswith(_DROPPED_SUFFIXES) or _DROPPED_KEYS.match(key):
            continue
        if key.endswith(scale_key_suffixes):
            scales[rename(key.rsplit(".", 1)[0])] = key
            continue
        name = rename(key)
        if any(name == s or name.startswith(s + ".") for s in skip):
            continue
        names[name] = key

    linears = {n for n, m in model.named_modules() if isinstance(m, nn.Linear)}
    quantized: dict[str, WeightOnlyLinear] = {}
    if storage in ("fp8", "int8"):
        chosen = [
            n
            for n in linears
            if f"{n}.weight" in names and not any(n == e or n.startswith(e + ".") for e in exclude)
        ]
        qdtype = torch.int8 if storage == "int8" else FP8
        stored = {n for n in chosen if n in scales or source.dtype(names[f"{n}.weight"]) == "F8_E4M3"}
        if stored:
            # A file that already stores FP8 layers decided which layers can take
            # it; the ones it kept in BF16 (fp8mixed) stay BF16 here too.
            chosen = [n for n in chosen if n in stored]
        # Stored FP8 keeps its per-tensor scale (or 1) bit-exact; everything that
        # is quantized here, LoRA-fused layers included, gets a per-row scale.
        per_tensor = {n for n in stored if n not in deltas}
        quantized.update(
            replace_linears(model, [n for n in chosen if n not in per_tensor], qdtype, compute_dtype, True)
        )
        quantized.update(replace_linears(model, sorted(per_tensor), qdtype, compute_dtype, False))
    dense_dtype = DTYPES.get(storage, compute_dtype)

    unused_deltas = set(deltas)
    with torch.no_grad():
        for name, key in names.items():
            owner, _, leaf = name.rpartition(".")
            tensor = source.get(key)
            module = quantized.get(owner)
            if module is not None and leaf == "weight":
                delta = deltas.get(owner)
                scale_key = scales.get(owner)
                stored_fp8 = tensor.dtype == FP8 and delta is None and not module.scale.dim()
                if stored_fp8:
                    q = tensor.to(device)
                    s = source.get(scale_key).reshape(()).float() if scale_key else torch.ones(())
                else:
                    w = tensor.to(device=device, dtype=torch.float32)
                    if scale_key:
                        w = w * source.get(scale_key).to(device=device, dtype=torch.float32)
                    if delta is not None:
                        w = _fuse(w, delta, device)
                        unused_deltas.discard(owner)
                    q, s = quantize(w, module.qweight.dtype, per_row=bool(module.scale.dim()))
                    del w
                module._buffers["qweight"] = q
                module._buffers["scale"] = s.to(device)
                continue
            target_dtype = dense_dtype if tensor.is_floating_point() else tensor.dtype
            value = tensor.to(
                device=device, dtype=torch.float32 if scales.get(owner) or owner in deltas else target_dtype
            )
            if leaf == "weight" and scales.get(owner):
                value = value * source.get(scales[owner]).to(device=device, dtype=torch.float32)
            if leaf == "weight" and owner in deltas:
                value = _fuse(value, deltas[owner], device)
                unused_deltas.discard(owner)
            _set(model, name, value.to(target_dtype))
    source.close()
    if unused_deltas:
        raise LoadError(f"LoRA targets modules the model does not have: {sorted(unused_deltas)[:5]}")
    for module_name in skip:
        parent_name, _, leaf = module_name.rpartition(".")
        parent = model.get_submodule(parent_name) if parent_name else model
        setattr(parent, leaf, nn.Identity())
    missing = [n for n, p in model.named_parameters() if p.is_meta]
    missing += [n for n, b in model.named_buffers() if b.is_meta]
    if missing:
        raise LoadError(f"{len(missing)} tensors missing from the checkpoint, e.g. {missing[:5]}")
    model.to(device)
    model.eval()
    model.requires_grad_(False)
    return model


def _fuse(weight: torch.Tensor, delta, device) -> torch.Tensor:
    down, up, factor = delta
    return (
        weight
        + (up.to(device=device, dtype=torch.float32) @ down.to(device=device, dtype=torch.float32)) * factor
    )


def meta_model(factory):
    from accelerate import init_empty_weights

    with init_empty_weights():
        return factory()
