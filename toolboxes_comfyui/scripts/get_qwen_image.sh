#!/usr/bin/env bash
# /opt/get_qwen.sh (resume-friendly, supports Qwen Image + Qwen Image Edit)
set -euo pipefail

export HF_XET_HIGH_PERFORMANCE="${HF_XET_HIGH_PERFORMANCE:-1}"
export HF_HOME="${HF_HOME:-$HOME/.cache/huggingface}"   # persistent HF cache
HF="/opt/venv/bin/hf"

MODEL_HOME="$HOME/comfy-models"
STAGE="$MODEL_HOME/.hf_stage_qwen"                      # persistent staging (resume support)

mkdir -p "$MODEL_HOME"/{text_encoders,vae,diffusion_models,unet,loras}
mkdir -p "$STAGE"

dl() {
  local repo="$1"
  local remote="$2"
  local subdir="$3"
  local target_name="${4:-$(basename "$remote")}"
  local dest="$MODEL_HOME/$subdir/$target_name"
  local staged="$STAGE/$remote"

  if [[ -f "$dest" ]]; then
    echo "✓ Already present: $dest"
    return
  fi

  echo "↓ Downloading $(basename "$remote") → $dest"
  mkdir -p "$(dirname "$staged")"
  "$HF" download "$repo" "$remote" \
      --repo-type model \
      --local-dir "$STAGE"
  mv -f "$staged" "$dest"
}

echo "Which Qwen variant do you want to download?"
echo "  1) Qwen-Image 2512 (20B text-to-image)"
echo "  2) Qwen-Image-Edit 2511 (image editing)"
echo "  3) Qwen-Image-Lightning LoRA (4-steps)"
echo "  4) Qwen-Image-Edit-Lightning LoRA (4-steps, bf16)"
echo "  5) Qwen-Image 2512 GGUF (Q4_K_M)"
echo "  6) Qwen-Image-Edit 2511 GGUF (Q4_K_M)"

# Check if an argument is provided
if [ -n "${1:-}" ]; then
  choice="$1"
else
  read -rp "Enter 1, 2, 3, 4, 5 or 6: " choice
fi

PRECISION="fp8"
if [[ "${2:-}" == "bf16" ]]; then
  PRECISION="bf16"
fi

case "$choice" in
  1)
    REPO="Comfy-Org/Qwen-Image_ComfyUI"
    echo "==> Downloading Qwen-Image 2512 (20B) - $PRECISION"
    if [[ "$PRECISION" == "bf16" ]]; then
         dl "$REPO" "split_files/diffusion_models/qwen_image_2512_bf16.safetensors" "diffusion_models"
    else
         dl "$REPO" "split_files/diffusion_models/qwen_image_2512_fp8_e4m3fn.safetensors" "diffusion_models"
    fi
    dl "$REPO" "split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors" "text_encoders"
    dl "$REPO" "split_files/vae/qwen_image_vae.safetensors" "vae"
    ;;
  2)
    REPO="Comfy-Org/Qwen-Image-Edit_ComfyUI"
    echo "==> Downloading Qwen-Image-Edit - $PRECISION"
    # Requires text encoder + VAE from Qwen-Image
    BASE="Comfy-Org/Qwen-Image_ComfyUI"
    dl "$BASE" "split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors" "text_encoders"
    dl "$BASE" "split_files/vae/qwen_image_vae.safetensors" "vae"
    
    if [[ "$PRECISION" == "bf16" ]]; then
        dl "$REPO" "split_files/diffusion_models/qwen_image_edit_2511_bf16.safetensors" "diffusion_models"
    else
        dl "$REPO" "split_files/diffusion_models/qwen_image_edit_2511_fp8mixed.safetensors" "diffusion_models"
    fi
    ;;
  3)
    REPO="lightx2v/Qwen-Image-2512-Lightning"
    echo "==> Downloading Qwen-Image-2512-Lightning LoRA"
    dl "$REPO" "Qwen-Image-2512-Lightning-4steps-V1.0-bf16.safetensors" "loras"
    ;;
  4)
    REPO="lightx2v/Qwen-Image-Edit-2511-Lightning"
    echo "==> Downloading Qwen-Image-Edit-Lightning LoRA"
    dl "$REPO" "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors" "loras"
    ;;
  5)
    echo "==> Downloading Qwen-Image 2512 GGUF (Q4_K_M)"
    dl "unsloth/Qwen-Image-2512-GGUF" \
       "qwen-image-2512-Q4_K_M.gguf" "unet"
    dl "unsloth/Qwen2.5-VL-7B-Instruct-GGUF" \
       "Qwen2.5-VL-7B-Instruct-UD-Q4_K_XL.gguf" "text_encoders"
    dl "unsloth/Qwen2.5-VL-7B-Instruct-GGUF" \
       "mmproj-BF16.gguf" "text_encoders" \
       "Qwen2.5-VL-7B-Instruct-mmproj-BF16.gguf"
    dl "Comfy-Org/Qwen-Image_ComfyUI" \
       "split_files/vae/qwen_image_vae.safetensors" "vae"
    ;;
  6)
    echo "==> Downloading Qwen-Image-Edit 2511 GGUF (Q4_K_M)"
    dl "unsloth/Qwen-Image-Edit-2511-GGUF" \
       "qwen-image-edit-2511-Q4_K_M.gguf" "unet"
    dl "unsloth/Qwen2.5-VL-7B-Instruct-GGUF" \
       "Qwen2.5-VL-7B-Instruct-UD-Q4_K_XL.gguf" "text_encoders"
    dl "unsloth/Qwen2.5-VL-7B-Instruct-GGUF" \
       "mmproj-BF16.gguf" "text_encoders" \
       "Qwen2.5-VL-7B-Instruct-mmproj-BF16.gguf"
    dl "Comfy-Org/Qwen-Image_ComfyUI" \
       "split_files/vae/qwen_image_vae.safetensors" "vae"
    ;;
  *)
    echo "Invalid choice. Exiting."
    exit 1
    ;;
esac

echo "✓ Models ready in $MODEL_HOME"
