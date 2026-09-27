"""MiniMax-H3 on diffusers' modular pipeline (diffusers >= 0.40).

The blocks are diffusers' MiniMaxH3Blocks; every component is built here from
the local diffusers-format directory, so nothing resolves the repo id that
modular_model_index.json names. Transformer and Qwen3-VL conditioner stream in
as INT8 weight-only (loaders.py), the Turbo LoRA fused into the BF16 weights
before they are quantized.

The two checkpoint partitions share everything except the transformer:
`transformer` serves t2va/fl2va, `transformer_ref` serves ref2va. Only one is
resident; a request for the other swaps it and keeps the rest loaded.
"""

from __future__ import annotations

from typing import Any

from ..errors import JobCancelled
from ..jobs import JobContext
from .base import Artifact, GenerationRequest, Provider
from .loaders import DTYPES, TensorSource, load_streaming, lora_deltas, meta_model
from .media import as_uint8_frames, encode_video

PARTITION = {
    "text-to-video": "transformer",
    "image-to-video": "transformer",
    "start-end-to-video": "transformer",
    "reference-to-video": "transformer_ref",
}


class MiniMaxH3Provider(Provider):
    def _device(self):
        import torch

        return torch.device(self.settings.device)

    def load(self, ctx: JobContext) -> None:
        import torch
        from diffusers import (
            AutoencoderKLMiniMaxH3,
            AutoencoderKLMiniMaxH3Audio,
            MiniMaxH3Blocks,
            MiniMaxH3Scheduler,
        )
        from transformers import AutoConfig, AutoProcessor, AutoTokenizer, Qwen3VLForConditionalGeneration

        base = self.settings.models_dir / self.model.base.path
        device = self._device()
        comps = self.profile.components
        te_spec = comps["text_encoder"]
        ctx.report("loading_model", 0.05)
        config = AutoConfig.from_pretrained(base / "text_encoder", local_files_only=True)
        te = meta_model(lambda: Qwen3VLForConditionalGeneration(config))
        # The blocks call text_encoder.model and read hidden_states[50]; the LM head is dead weight.
        text_encoder = load_streaming(
            te,
            TensorSource.for_dir(base / "text_encoder", self.settings.disable_mmap),
            device=device,
            compute_dtype=torch.bfloat16,
            storage=te_spec.storage,
            exclude=te_spec.options.get("exclude", ()),
            skip=("lm_head",),
        )
        ctx.report("loading_model", 0.45)
        vae = AutoencoderKLMiniMaxH3.from_pretrained(
            base, subfolder="vae", torch_dtype=DTYPES[comps["vae"].storage], local_files_only=True
        ).to(device)
        audio_vae = AutoencoderKLMiniMaxH3Audio.from_pretrained(
            base, subfolder="audio_vae", torch_dtype=DTYPES[comps["audio_vae"].storage], local_files_only=True
        ).to(device)
        self.pipe = MiniMaxH3Blocks().init_pipeline()
        self.pipe.update_components(
            text_encoder=text_encoder,
            tokenizer=AutoTokenizer.from_pretrained(base / "tokenizer", local_files_only=True),
            processor=AutoProcessor.from_pretrained(base / "processor", local_files_only=True),
            vae=vae,
            audio_vae=audio_vae,
            scheduler=MiniMaxH3Scheduler.from_pretrained(base, subfolder="scheduler", local_files_only=True),
            audio_scheduler=MiniMaxH3Scheduler.from_pretrained(
                base, subfolder="audio_scheduler", local_files_only=True
            ),
        )
        self.partition: str | None = None
        ctx.report("loading_model", 0.5)

    def _ensure_partition(self, task: str, ctx: JobContext):
        from diffusers import MiniMaxH3Transformer3DModel

        from ..lifecycle import release_memory

        wanted = PARTITION[task]
        if self.partition == wanted:
            return getattr(self.pipe, wanted)
        if self.partition is not None:
            self.pipe.update_components(**{self.partition: None})
            self.partition = None
            release_memory()
        import torch

        spec = self.profile.components[wanted]
        base = self.settings.models_dir / self.model.base.path
        config = MiniMaxH3Transformer3DModel.load_config(base / wanted)
        model = meta_model(lambda: MiniMaxH3Transformer3DModel.from_config(config))
        deltas = None
        if self.profile.lora is not None:
            from diffusers import MiniMaxH3ModularPipeline

            lora = self.profile.lora
            state = MiniMaxH3ModularPipeline.lora_state_dict(str(self.settings.models_dir / lora.file.path))
            deltas = lora_deltas(state, "transformer.", lora.scale)
        ctx.report("loading_model", 0.55)
        transformer = load_streaming(
            model,
            TensorSource.for_dir(base / wanted, self.settings.disable_mmap),
            device=self._device(),
            compute_dtype=torch.bfloat16,
            storage=spec.storage,
            exclude=spec.options.get("exclude", ()),
            deltas=deltas,
        )
        self.pipe.update_components(**{wanted: transformer})
        self.partition = wanted
        return transformer

    def unload(self) -> None:
        self.pipe = None

    def generate(self, request: GenerationRequest, ctx: JobContext) -> Artifact:
        import torch
        from diffusers.modular_pipelines.minimax_h3 import MiniMaxH3ImageReference
        from PIL import Image

        transformer = self._ensure_partition(request.task, ctx)
        ctx.report("generating", 0.0)
        calls = {"n": 0}

        def on_forward(module, args, kwargs):
            if ctx.cancelled:
                raise JobCancelled()
            calls["n"] += 1
            ctx.report("generating", min(1.0, calls["n"] / request.steps))

        def rgb(path):
            with Image.open(path) as image:
                return image.convert("RGB")

        args: dict[str, Any] = dict(
            prompt=request.prompt,
            height=request.height,
            width=request.width,
            num_frames=request.num_frames,
            # diffusers counts sigma grid points including the terminal 0, i.e.
            # one more than the number of model evaluations the API promises.
            num_inference_steps=request.steps + 1,
            generator=torch.Generator().manual_seed(request.seed),
            output=["videos", "audio", "sampling_rate"],
            output_type="np",
        )
        if request.start_image is not None:
            args["image"] = rgb(request.start_image)
        if request.end_image is not None:
            args["last_image"] = rgb(request.end_image)
        if request.reference_images:
            args["references"] = [MiniMaxH3ImageReference(rgb(p)) for p in request.reference_images]
        handle = transformer.register_forward_pre_hook(on_forward, with_kwargs=True)
        try:
            with torch.inference_mode():
                results = self.pipe(**args)
        finally:
            handle.remove()
        ctx.report("encoding", 1.0)
        frames = as_uint8_frames(results["videos"][0])
        audio = None
        if request.audio:
            audio = results["audio"][0].float().cpu().numpy()
        path, content_type = encode_video(
            frames, 24, request.output_dir, request.output_format, audio, int(results["sampling_rate"])
        )
        return Artifact(
            path, content_type, frames.shape[2], frames.shape[1], frames.shape[0], 24, audio is not None
        )
