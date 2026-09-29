#!/usr/bin/env bash
#
# Builds the media API image.
#
# Usage: ./build.sh [image-tag] [--cpu-torch]
#   image-tag    what to tag locally (default: media-api-local)
#   --cpu-torch  PyTorch's CPU wheels instead of TheRock's gfx1151 ones: only
#                for running ./smoke-test.sh (mock mode) on a machine without
#                the bandwidth or disk for ROCm. Never publish such an image.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TAG="media-api-local"
EXTRA=()
for arg in "$@"; do
  case "$arg" in
    --cpu-torch)
      EXTRA+=(--build-arg "TORCH_INDEX_URL=https://download.pytorch.org/whl/cpu"
              --build-arg "TORCH_PACKAGES=torch torchvision")
      ;;
    -*) echo "Unbekannte Option: $arg" >&2; exit 1 ;;
    *) TAG="$arg" ;;
  esac
done

RUNTIME="podman"
command -v podman >/dev/null 2>&1 || RUNTIME="docker"
command -v "$RUNTIME" >/dev/null 2>&1 || { echo "Weder podman noch docker gefunden." >&2; exit 1; }

echo "==> Baue $TAG aus $HERE"
"$RUNTIME" build -t "$TAG" -f "$HERE/Dockerfile.media-api" "${EXTRA[@]}" "$HERE"

cat <<EOT

Fertig: $TAG
Hardened localhost start (as root, on rootful Podman like the ComfyUI and llama.cpp containers):
  install -d -m 700 "\$HOME/.config/media-api"
  umask 077; python3 -c 'import secrets; print(secrets.token_urlsafe(32))' > "\$HOME/.config/media-api/api-key"
  podman run -d --name media-api \\
    --device /dev/dri --device /dev/kfd --group-add video --group-add render \\
    --cap-drop=all --security-opt=no-new-privileges --security-opt=seccomp=unconfined \\
    -p 127.0.0.1:8100:8100 -e MEDIA_HOST=0.0.0.0 \\
    -e MEDIA_API_KEY_FILE=/run/secrets/media-api-key \\
    -v "\$HOME/.config/media-api/api-key:/run/secrets/media-api-key:ro,z" \\
    -v "\$HOME/comfy-models:/models:ro,z" \\
    -v "\$HOME/media-api-data:/data:z" \\
    $TAG
For remote access, keep this loopback binding and use a TLS reverse proxy with MEDIA_COOKIE_SECURE=1.
See README.md for the seccomp=unconfined residual risk.
EOT
