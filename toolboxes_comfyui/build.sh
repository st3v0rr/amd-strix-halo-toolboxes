#!/usr/bin/env bash
#
# Builds the ComfyUI server image.
#
# Everything it needs is in this directory — see UPSTREAM.md for where scripts/
# and workflows/ came from. Nothing is fetched from the toolbox repository, so
# this keeps working if that repository moves or disappears.
#
# Usage: ./build.sh [image-tag]
#   image-tag  what to tag locally (default: comfyui-local)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TAG="${1:-comfyui-local}"

RUNTIME="podman"
command -v podman >/dev/null 2>&1 || RUNTIME="docker"
command -v "$RUNTIME" >/dev/null 2>&1 || { echo "Weder podman noch docker gefunden." >&2; exit 1; }

echo "==> Baue $TAG aus $HERE"
"$RUNTIME" build -t "$TAG" -f "$HERE/Dockerfile.comfyui" "$HERE"

cat <<EOF

Fertig: $TAG
Starten z. B. mit:
  $RUNTIME run -d --name comfyui \\
    --device /dev/dri --device /dev/kfd \\
    --group-add video --group-add render --security-opt seccomp=unconfined \\
    -p 8000:8000 \\
    -v "\$HOME/comfy-models:/root/comfy-models:z" \\
    -v "\$HOME/comfy-outputs:/root/comfy-outputs:z" \\
    $TAG
EOF
