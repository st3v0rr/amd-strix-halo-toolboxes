#!/bin/bash
# setup_extra_paths.sh

set -euo pipefail

CONFY_DIR="/opt/ComfyUI"
YAML_FILE="$CONFY_DIR/extra_model_paths.yaml"
MODEL_DIR="$HOME/comfy-models"

mkdir -p "$MODEL_DIR"/{checkpoints,text_encoders,vae,diffusion_models,unet,loras,latent_upscale_models,clip_vision}

cat > "$YAML_FILE" <<EOF
comfyui:
    base_path: $MODEL_DIR

    text_encoders: text_encoders
    vae: vae
    checkpoints: checkpoints
    diffusion_models: diffusion_models
    unet: unet
    loras: loras
    latent_upscale_models: latent_upscale_models
    clip_vision: clip_vision
EOF

echo "✅ Wrote $YAML_FILE"
