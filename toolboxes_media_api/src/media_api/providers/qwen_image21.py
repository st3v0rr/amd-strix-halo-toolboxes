"""Qwen-Image-2.1: text-to-image and image editing in one model, on diffusers.

The pipeline is diffusers' own QwenImage21Pipeline; this module loads its
parts. The transformer comes from Comfy-Org's single file (its fused gate_up
projections split on the way in, see loaders.SplitGateUpSource), the Qwen3-VL
text encoder from Comfy-Org's single file too, and the processor, scheduler
and VAE from the model's diffusers base directory.

Turbo (8 steps) and Lightning (4 steps) are the base transformer with a
LoRA fused in — Comfy-Org's extraction of Qwen-Image-2.1-Turbo, and
lightx2v's Lightning v2-RL — each sampled on its release's own sigmas without
dynamic shifting. LoRAs rather than the distilled checkpoints, so one set of
base weights on disk serves all three profiles.

The model draws RGBA: an image with transparent areas is saved with its alpha
channel (PNG/WebP). Inputs keep theirs too; the pipeline composites them over
white for the vision encoder and gives the VAE all four channels.
"""

from __future__ import annotations

from typing import Any

from ..errors import JobCancelled, ProviderError
from ..jobs import JobContext
from .base import Artifact, GenerationRequest, Provider
from .loaders import (
    DTYPES,
    SplitGateUpSource,
    TensorSource,
    comfy_lora_deltas,
    load_streaming,
    meta_model,
    qwen3vl_name,
)
from .media import open_rgba, save_image


class QwenImage21Provider(Provider):
    def _path(self, ref) -> str:
        return str(self.settings.models_dir / ref.path)

    def load(self, ctx: JobContext) -> None:
        import torch
        from diffusers import AutoencoderKLQwenImage21, FlowMatchEulerDiscreteScheduler, QwenImage21Pipeline
        from transformers import AutoProcessor

        base = self.settings.models_dir / self.model.base.path
        device = torch.device(self.settings.device)
        comps = self.profile.components
        ctx.report("loading_model", 0.05)
        transformer = self._load_transformer(base, comps["transformer"], device)
        ctx.report("loading_model", 0.5)
        text_encoder = self._load_text_encoder(base, comps["text_encoder"], device)
        ctx.report("loading_model", 0.9)
        vae = AutoencoderKLQwenImage21.from_pretrained(
            base, subfolder="vae", torch_dtype=DTYPES[comps["vae"].storage], local_files_only=True
        ).to(device)
        config = dict(FlowMatchEulerDiscreteScheduler.load_config(base / "scheduler"))
        if self.profile.scheduler == "fixed-sigmas":
            # What Qwen-Image-2.1-Turbo and lightx2v's Lightning ship: the base
            # scheduler without dynamic shifting or a terminal shift, so their
            # (already shifted) sigmas are used as given.
            config.update(use_dynamic_shifting=False, shift_terminal=None)
        scheduler = FlowMatchEulerDiscreteScheduler.from_config(config)
        processor = AutoProcessor.from_pretrained(base / "processor", local_files_only=True)
        self.pipe: Any = QwenImage21Pipeline(
            scheduler=scheduler,
            vae=vae,
            text_encoder=text_encoder,
            processor=processor,
            transformer=transformer,
            sample_sigmas=list(self.profile.sigmas) or None,
        )
        self.pipe.set_progress_bar_config(disable=True)

    def _deltas(self):
        lora = self.profile.lora
        if lora is None:
            return None
        from safetensors.torch import load_file

        return comfy_lora_deltas(load_file(self._path(lora.file)), lora.scale)

    def _load_transformer(self, base, spec, device):
        import torch
        from diffusers import QwenImage21Transformer2DModel

        if spec.format != "comfy-single-file":
            raise ProviderError("invalid_configuration", f"unsupported transformer format {spec.format}")
        config = QwenImage21Transformer2DModel.load_config(base / "transformer")
        model = meta_model(lambda: QwenImage21Transformer2DModel.from_config(config))
        source = SplitGateUpSource(
            TensorSource([self.settings.models_dir / spec.file.path], self.settings.disable_mmap)
        )
        return load_streaming(
            model,
            source,
            device=device,
            compute_dtype=torch.bfloat16,
            storage=spec.storage,
            rename=lambda key: key.removeprefix("model.diffusion_model."),
            deltas=self._deltas(),
        )

    def _load_text_encoder(self, base, spec, device):
        import torch
        from transformers import AutoConfig, Qwen3VLForConditionalGeneration

        if spec.format != "comfy-qwen3-vl":
            raise ProviderError("invalid_configuration", f"unsupported text encoder format {spec.format}")
        config = AutoConfig.from_pretrained(base / "text_encoder", local_files_only=True)
        model = meta_model(lambda: Qwen3VLForConditionalGeneration(config))
        source = TensorSource([self.settings.models_dir / spec.file.path], self.settings.disable_mmap)
        # The pipeline reads hidden states only; the 1.2 GB language-model head is never used.
        return load_streaming(
            model,
            source,
            device=device,
            compute_dtype=torch.bfloat16,
            storage=spec.storage,
            rename=qwen3vl_name,
            exclude=("model.visual.patch_embed", "model.language_model.embed_tokens"),
            skip=("lm_head",),
        )

    def unload(self) -> None:
        self.pipe = None

    def generate(self, request: GenerationRequest, ctx: JobContext) -> Artifact:
        import torch

        sigmas = list(self.profile.sigmas)
        steps = len(sigmas) if sigmas else request.steps

        def on_step(pipe, step, timestep, kwargs):
            if ctx.cancelled:
                raise JobCancelled()
            ctx.report("generating", (step + 1) / steps)
            return kwargs

        guidance = request.guidance if request.guidance is not None else 1.0
        args: dict[str, Any] = dict(
            prompt=request.prompt,
            true_cfg_scale=guidance,
            num_inference_steps=steps,
            generator=torch.Generator(device="cpu").manual_seed(request.seed),
            callback_on_step_end=on_step,
            output_type="pil",
        )
        # CFG only runs with a negative prompt and guidance above 1; passing one
        # otherwise only makes the pipeline warn.
        if guidance > 1.0:
            args["negative_prompt"] = request.negative_prompt or " "
        if request.width and request.height:
            args.update(width=request.width, height=request.height)
        if request.task == "image-edit":
            args["image"] = [open_rgba(path) for path in request.images]
        with torch.inference_mode():
            image = self.pipe(**args).images[0]
        ctx.report("encoding", 1.0)
        path, content_type = save_image(image, request.output_dir, request.output_format)
        return Artifact(path, content_type, image.width, image.height)
