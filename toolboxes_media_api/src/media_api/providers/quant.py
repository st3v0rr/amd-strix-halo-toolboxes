"""Weight-only quantized linear layers in plain PyTorch.

Weights are held as FP8 E4M3FN or INT8 with an FP32 scale (per tensor, or per
output row) and dequantized to the activation dtype on every forward; the
matrix multiply itself runs in BF16. No custom kernels, no torchao, no
bitsandbytes: on gfx1151 torchao's int8 paths are slow or refuse to run and
bitsandbytes has no verified build, while cast-then-matmul is the mechanism
ComfyUI's FP8 weights already use on this hardware.
"""

from __future__ import annotations

import torch
import torch.nn.functional as F
from torch import nn

FP8 = torch.float8_e4m3fn
FP8_MAX = 448.0


class WeightOnlyLinear(nn.Module):
    def __init__(self, in_features, out_features, bias, qdtype, compute_dtype, per_row, device=None):
        super().__init__()
        self.in_features = in_features
        self.out_features = out_features
        self.compute_dtype = compute_dtype
        self.register_buffer("qweight", torch.empty((out_features, in_features), dtype=qdtype, device=device))
        scale_shape = (out_features, 1) if per_row else ()
        self.register_buffer("scale", torch.ones(scale_shape, dtype=torch.float32, device=device))
        if bias:
            self.bias = nn.Parameter(
                torch.empty(out_features, dtype=compute_dtype, device=device), requires_grad=False
            )
        else:
            self.register_parameter("bias", None)

    @classmethod
    def like(cls, linear: nn.Linear, qdtype, compute_dtype, per_row):
        return cls(
            linear.in_features,
            linear.out_features,
            linear.bias is not None,
            qdtype,
            compute_dtype,
            per_row,
            "meta",
        )

    def dequantize(self, dtype=None):
        dtype = dtype or self.compute_dtype
        return self.qweight.to(dtype) * self.scale.to(dtype)

    @property
    def weight(self):
        # For code that reads `.weight` (dtype or shape checks). Dequantizes, so
        # it is not for hot paths; forward() does the same inline.
        return self.dequantize()

    def forward(self, x):
        weight = self.qweight.to(x.dtype) * self.scale.to(x.dtype)
        bias = self.bias.to(x.dtype) if self.bias is not None else None
        return F.linear(x, weight, bias)

    def extra_repr(self):
        shape = tuple(self.scale.shape)
        return f"in={self.in_features}, out={self.out_features}, q={self.qweight.dtype}, scale={shape}"


def quantize(weight: torch.Tensor, qdtype, per_row: bool = True):
    """Symmetric absmax quantization; returns (qweight, fp32 scale)."""
    w = weight.float()
    amax = w.abs().amax(dim=1, keepdim=True) if per_row else w.abs().amax()
    qmax = 127.0 if qdtype == torch.int8 else FP8_MAX
    scale = (amax / qmax).clamp(min=1e-12)
    if qdtype == torch.int8:
        q = torch.round(w / scale).clamp(-127, 127).to(torch.int8)
    else:
        q = (w / scale).clamp(-FP8_MAX, FP8_MAX).to(qdtype)
    return q, scale.to(torch.float32)


def replace_linears(model: nn.Module, names, qdtype, compute_dtype, per_row) -> dict[str, WeightOnlyLinear]:
    """Swap the named nn.Linear modules (still on meta) for WeightOnlyLinear."""
    replaced: dict[str, WeightOnlyLinear] = {}
    for name in names:
        parent_name, _, leaf = name.rpartition(".")
        parent = model.get_submodule(parent_name) if parent_name else model
        linear = getattr(parent, leaf)
        if not isinstance(linear, nn.Linear):
            raise TypeError(f"{name} is {type(linear).__name__}, not nn.Linear")
        module = WeightOnlyLinear.like(linear, qdtype, compute_dtype, per_row)
        setattr(parent, leaf, module)
        replaced[name] = module
    return replaced
