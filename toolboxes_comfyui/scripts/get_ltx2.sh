#!/usr/bin/env bash
# Downloads LTX-2.3 model files for the bundled BF16 and GGUF workflows.
set -euo pipefail

export HF_XET_HIGH_PERFORMANCE="${HF_XET_HIGH_PERFORMANCE:-1}"
export HF_HOME="${HF_HOME:-$HOME/.cache/huggingface}"
HF="/opt/venv/bin/hf"

MODEL_HOME="$HOME/comfy-models"
STAGE="$MODEL_HOME/.hf_stage_ltx23"

LTX_REPO="Lightricks/LTX-2.3"
COMFY_LTX23_REPO="Comfy-Org/ltx-2.3"
COMFY_LTX2_REPO="Comfy-Org/ltx-2"
GGUF_REPO="unsloth/LTX-2.3-GGUF"
GGUF_GEMMA_REPO="unsloth/gemma-3-12b-it-qat-GGUF"

mkdir -p "$MODEL_HOME"/{checkpoints,text_encoders,vae,unet,loras,latent_upscale_models}
mkdir -p "$STAGE"

download_if_missing() {
  local repo="$1"
  local remote="$2"
  local subdir="$3"
  local target_name="${4:-$(basename "$remote")}"
  local destination="$MODEL_HOME/$subdir/$target_name"
  local staged="$STAGE/$remote"

  if [[ -f "$destination" ]]; then
    echo "✓ Already present: $destination"
    return
  fi

  echo "↓ Downloading $(basename "$remote") → $destination"
  mkdir -p "$(dirname "$staged")"
  "$HF" download "$repo" "$remote" --repo-type model --local-dir "$STAGE"
  mv -f "$staged" "$destination"
}

usage() {
  cat <<'USAGE'
Usage: get_ltx2.sh <target>

BF16 targets (native Strix Halo default):
  bf16-common     Gemma FP4 text encoder + LTX-2.3 x2 spatial upscaler
  bf16-dev        LTX-2.3 22B dev BF16 checkpoint
  bf16-distilled  LTX-2.3 22B distilled 1.1 BF16 checkpoint (no LoRA)
  bf16-loras      Compact distilled 1.1 LoRA + Gemma prompt LoRA

GGUF targets (lower-memory alternative):
  gguf-common     GGUF Gemma, projector, connector, VAEs + spatial upscaler
  gguf-dev        LTX-2.3 22B dev Q6_K diffusion model
  gguf-distilled  LTX-2.3 22B distilled Q6_K diffusion model (no LoRA)
  gguf-lora       Full-rank LTX-2.3 distilled 1.1 LoRA for the dev GGUF

Maintenance:
  clean-stage     Remove the resumable staging directory
  clean-cache     Remove the Hugging Face cache

FP8 is intentionally not auto-selected: gfx1151 computes through its native
BF16/FP16 paths. The official FP8 files can still be installed manually.
USAGE
}

case "${1:-}" in
  bf16-common|common)
    download_if_missing \
      "$COMFY_LTX2_REPO" \
      "split_files/text_encoders/gemma_3_12B_it_fp4_mixed.safetensors" \
      "text_encoders"
    download_if_missing \
      "$LTX_REPO" \
      "ltx-2.3-spatial-upscaler-x2-1.1.safetensors" \
      "latent_upscale_models"
    ;;
  bf16-dev)
    download_if_missing \
      "$LTX_REPO" \
      "ltx-2.3-22b-dev.safetensors" \
      "checkpoints"
    ;;
  bf16-distilled)
    download_if_missing \
      "$LTX_REPO" \
      "ltx-2.3-22b-distilled-1.1.safetensors" \
      "checkpoints"
    ;;
  bf16-loras)
    download_if_missing \
      "$COMFY_LTX23_REPO" \
      "split_files/loras/ltx_2.3_22b_distilled_1.1_lora_dynamic_fro09_avg_rank_111_bf16.safetensors" \
      "loras"
    download_if_missing \
      "$COMFY_LTX2_REPO" \
      "split_files/loras/gemma-3-12b-it-abliterated_lora_rank64_bf16.safetensors" \
      "loras"
    ;;
  gguf-common)
    legacy_audio_vae="$MODEL_HOME/vae/ltx-2.3-22b-dev_audio_vae.safetensors"
    audio_vae="$MODEL_HOME/checkpoints/ltx-2.3-22b-dev_audio_vae.safetensors"
    if [[ -f "$legacy_audio_vae" && ! -f "$audio_vae" ]]; then
      echo "→ Moving LTX-2.3 audio VAE to the checkpoints directory required by LTXVAudioVAELoader"
      mv "$legacy_audio_vae" "$audio_vae"
    fi
    download_if_missing \
      "$GGUF_GEMMA_REPO" \
      "gemma-3-12b-it-qat-UD-Q4_K_XL.gguf" \
      "text_encoders"
    download_if_missing \
      "$GGUF_GEMMA_REPO" \
      "mmproj-BF16.gguf" \
      "text_encoders" \
      "gemma-3-12b-it-qat-mmproj-BF16.gguf"
    download_if_missing \
      "$GGUF_REPO" \
      "text_encoders/ltx-2.3-22b-dev_embeddings_connectors.safetensors" \
      "text_encoders"
    download_if_missing \
      "$GGUF_REPO" \
      "vae/ltx-2.3-22b-dev_video_vae.safetensors" \
      "vae"
    download_if_missing \
      "$GGUF_REPO" \
      "vae/ltx-2.3-22b-dev_audio_vae.safetensors" \
      "checkpoints"
    download_if_missing \
      "$LTX_REPO" \
      "ltx-2.3-spatial-upscaler-x2-1.1.safetensors" \
      "latent_upscale_models"
    ;;
  gguf-dev)
    download_if_missing \
      "$GGUF_REPO" \
      "ltx-2.3-22b-dev-Q6_K.gguf" \
      "unet"
    ;;
  gguf-distilled)
    download_if_missing \
      "$GGUF_REPO" \
      "distilled/ltx-2.3-22b-distilled-Q6_K.gguf" \
      "unet"
    ;;
  gguf-lora)
    download_if_missing \
      "$LTX_REPO" \
      "ltx-2.3-22b-distilled-lora-384-1.1.safetensors" \
      "loras"
    ;;
  clean-stage)
    rm -rf "$STAGE"
    echo "✓ Removed stage: $STAGE"
    ;;
  clean-cache)
    rm -rf "$HF_HOME"
    echo "✓ Removed cache: $HF_HOME"
    ;;
  ""|-h|--help|help)
    usage
    ;;
  *)
    echo "Unknown target: $1" >&2
    usage
    exit 1
    ;;
esac

echo "✓ Done."
