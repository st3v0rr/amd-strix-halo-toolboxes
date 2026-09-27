"""Qwen-Image-2512 (text-to-image) and Qwen-Image-Edit-2511 (image edit) on diffusers.

The pipelines are diffusers' own QwenImagePipeline / QwenImageEditPlusPipeline;
this module only decides how their transformer and text encoder get into
memory (see loaders.py) and where the configs, tokenizer, processor, scheduler
and VAE come from (the model's diffusers base directory).
"""

from __future__ import annotations

import math
from typing import Any

from ..errors import JobCancelled, ProviderError
from ..jobs import JobContext
from .base import Artifact, GenerationRequest, Provider
from .loaders import (
    COMFY_PREFIX,
    DTYPES,
    TensorSource,
    legacy_qwen25vl_name,
    load_streaming,
    lora_deltas,
    meta_model,
)
from .media import save_image

# ModelTC/Qwen-Image-Lightning's diffusers settings: the LoRAs were distilled at shift 3.
LIGHTNING_SCHEDULER = {
    "base_image_seq_len": 256,
    "base_shift": math.log(3),
    "invert_sigmas": False,
    "max_image_seq_len": 8192,
    "max_shift": math.log(3),
    "num_train_timesteps": 1000,
    "shift": 1.0,
    "shift_terminal": None,
    "stochastic_sampling": False,
    "time_shift_type": "exponential",
    "use_beta_sigmas": False,
    "use_dynamic_shifting": True,
    "use_exponential_sigmas": False,
    "use_karras_sigmas": False,
}


class QwenImageProvider(Provider):
    edit = False

    def _device(self):
        import torch

        return torch.device(self.settings.device)

    def _path(self, ref) -> str:
        return str(self.settings.models_dir / ref.path)

    def load(self, ctx: JobContext) -> None:
        import torch
        from diffusers import (
            AutoencoderKLQwenImage,
            FlowMatchEulerDiscreteScheduler,
            QwenImageEditPlusPipeline,
            QwenImagePipeline,
        )
        from transformers import AutoTokenizer

        base = self.settings.models_dir / self.model.base.path
        device = self._device()
        comps = self.profile.components
        ctx.report("loading_model", 0.05)
        transformer = self._load_transformer(base, comps["transformer"], device)
        ctx.report("loading_model", 0.6)
        text_encoder = self._load_text_encoder(base, comps["text_encoder"], device)
        ctx.report("loading_model", 0.9)
        vae = AutoencoderKLQwenImage.from_pretrained(
            base, subfolder="vae", torch_dtype=DTYPES[comps["vae"].storage], local_files_only=True
        ).to(device)
        if self.profile.scheduler == "lightning":
            scheduler = FlowMatchEulerDiscreteScheduler.from_config(LIGHTNING_SCHEDULER)
        else:
            scheduler = FlowMatchEulerDiscreteScheduler.from_pretrained(
                base, subfolder="scheduler", local_files_only=True
            )
        tokenizer = AutoTokenizer.from_pretrained(base / "tokenizer", local_files_only=True)
        parts = dict(
            transformer=transformer,
            text_encoder=text_encoder,
            vae=vae,
            scheduler=scheduler,
            tokenizer=tokenizer,
        )
        self.pipe: Any
        if self.edit:
            from transformers import AutoProcessor

            processor = AutoProcessor.from_pretrained(base / "processor", local_files_only=True)
            self.pipe = QwenImageEditPlusPipeline(processor=processor, **parts)
        else:
            self.pipe = QwenImagePipeline(**parts)
        self.pipe.set_progress_bar_config(disable=True)
        self._generator_device = "cpu"
        del torch  # keep the name out of the instance namespace

    def _deltas(self):
        lora = self.profile.lora
        if lora is None:
            return None
        from diffusers import QwenImagePipeline

        state = QwenImagePipeline.lora_state_dict(self._path(lora.file))
        return lora_deltas(state, "transformer.", lora.scale)

    def _load_transformer(self, base, spec, device):
        import torch
        from diffusers import QwenImageTransformer2DModel

        compute = torch.bfloat16
        if spec.format == "gguf":
            from diffusers import GGUFQuantizationConfig

            return QwenImageTransformer2DModel.from_single_file(
                self._path(spec.file),
                quantization_config=GGUFQuantizationConfig(compute_dtype=compute),
                config=str(base),
                subfolder="transformer",
                torch_dtype=compute,
                local_files_only=True,
                disable_mmap=self.settings.disable_mmap,
            ).to(device)
        config = QwenImageTransformer2DModel.load_config(base / "transformer")
        model = meta_model(lambda: QwenImageTransformer2DModel.from_config(config))
        source = TensorSource([self.settings.models_dir / spec.file.path], self.settings.disable_mmap)
        return load_streaming(
            model,
            source,
            device=device,
            compute_dtype=compute,
            storage=spec.storage,
            rename=lambda key: key.removeprefix(COMFY_PREFIX),
            deltas=self._deltas(),
        )

    def _load_text_encoder(self, base, spec, device):
        import torch
        from transformers import AutoConfig, Qwen2_5_VLForConditionalGeneration

        if spec.format != "comfy-qwen2.5-vl":
            raise ProviderError("invalid_configuration", f"unsupported text encoder format {spec.format}")
        config = AutoConfig.from_pretrained(base / "text_encoder", local_files_only=True)
        model = meta_model(lambda: Qwen2_5_VLForConditionalGeneration(config))
        source = TensorSource([self.settings.models_dir / spec.file.path], self.settings.disable_mmap)
        # The pipelines read hidden states only; the 1 GB language-model head is never used.
        return load_streaming(
            model,
            source,
            device=device,
            compute_dtype=torch.bfloat16,
            storage=spec.storage,
            rename=legacy_qwen25vl_name,
            exclude=("model.visual.patch_embed", "model.language_model.embed_tokens"),
            skip=("lm_head",),
        )

    def unload(self) -> None:
        self.pipe = None

    def generate(self, request: GenerationRequest, ctx: JobContext) -> Artifact:
        import torch
        from PIL import Image

        steps = request.steps

        def on_step(pipe, step, timestep, kwargs):
            if ctx.cancelled:
                raise JobCancelled()
            ctx.report("generating", (step + 1) / steps)
            return kwargs

        args: dict[str, Any] = dict(
            prompt=request.prompt,
            negative_prompt=request.negative_prompt,
            true_cfg_scale=request.guidance if request.guidance is not None else 1.0,
            num_inference_steps=steps,
            generator=torch.Generator(device=self._generator_device).manual_seed(request.seed),
            callback_on_step_end=on_step,
            output_type="pil",
        )
        if request.width and request.height:
            args.update(width=request.width, height=request.height)
        if self.edit:
            images = []
            for path in request.images:
                with Image.open(path) as image:
                    images.append(image.convert("RGB"))
            args["image"] = images
        with torch.inference_mode():
            image = self.pipe(**args).images[0]
        ctx.report("encoding", 1.0)
        path, content_type = save_image(image, request.output_dir, request.output_format)
        return Artifact(path, content_type, image.width, image.height)


class QwenImageEditProvider(QwenImageProvider):
    edit = True
