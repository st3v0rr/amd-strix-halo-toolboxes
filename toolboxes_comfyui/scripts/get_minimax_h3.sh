#!/usr/bin/env bash
# Downloads the open-weight MiniMax-H3 model files for ComfyUI.
set -euo pipefail

export HF_XET_HIGH_PERFORMANCE="${HF_XET_HIGH_PERFORMANCE:-1}"
export HF_HOME="${HF_HOME:-$HOME/.cache/huggingface}"
HF="/opt/venv/bin/hf"

MODEL_HOME="$HOME/comfy-models"
STAGE="$MODEL_HOME/.hf_stage_minimax_h3"
REPO="Comfy-Org/MiniMax-H3"
TURBO_REPO="larryvrh/MiniMax-H3-Turbo-Lora"
GGUF_REPO="unsloth/MiniMax-H3-GGUF"

mkdir -p "$MODEL_HOME"/{text_encoders,vae,diffusion_models,unet,loras}
mkdir -p "$STAGE"

download_if_missing() {
  local remote="$1"
  local subdir="$2"
  local repo="${3:-$REPO}"
  local destination="$MODEL_HOME/$subdir/$(basename "$remote")"
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
Usage: get_minimax_h3.sh <target>

Targets:
  common      Shared text encoder and video/audio VAEs
  fl2va       T2V and I2V diffusion model
  ref2va      Reference-to-video diffusion model
  turbo       MiniMax-H3 Turbo LoRA (v4, step 600 EMA)
  gguf-common Shared Q2_K_M text encoder and video/audio VAEs
  gguf-fl2va  T2V/I2V UD-Q2_K_XL GGUF diffusion model
  gguf-ref2va R2V Q2_K GGUF diffusion model
  all         All H3 models

Maintenance:
  clean-stage Remove the resumable staging directory
  clean-cache Remove the Hugging Face cache
USAGE
}

case "${1:-}" in
  common)
    download_if_missing "text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors" "text_encoders"
    download_if_missing "vae/minimax_h3_video_vae_fp16.safetensors" "vae"
    download_if_missing "vae/minimax_h3_audio_vae_fp32.safetensors" "vae"
    ;;
  fl2va)
    download_if_missing "diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors" "diffusion_models"
    ;;
  ref2va)
    download_if_missing "diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors" "diffusion_models"
    ;;
  turbo)
    download_if_missing "minimax_h3_turbo_v4_step600_ema.safetensors" "loras" "$TURBO_REPO"
    ;;
  gguf-common)
    download_if_missing "qwen3vl_32b_minimax_h3-Q2_K_M.gguf" "text_encoders" "$GGUF_REPO"
    download_if_missing "vae/minimax_h3_video_vae_fp16.safetensors" "vae"
    download_if_missing "vae/minimax_h3_audio_vae_fp32.safetensors" "vae"
    ;;
  gguf-fl2va)
    download_if_missing "minimax_h3_fl2va_pruned-UD-Q2_K_XL.gguf" "unet" "$GGUF_REPO"
    ;;
  gguf-ref2va)
    download_if_missing "minimax_h3_ref2va_pruned-Q2_K.gguf" "unet" "$GGUF_REPO"
    ;;
  all)
    "$0" common
    "$0" fl2va
    "$0" ref2va
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
