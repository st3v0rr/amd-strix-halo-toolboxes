#!/usr/bin/env bash
#
# Builds the ComfyUI server image.
#
# Dockerfile.comfyui is a copy of upstream's, so it COPYs from their build
# context — scripts/ and workflows/. Those are not vendored into this fork on
# purpose: they are a few dozen files that change whenever a new model comes
# out, and a stale copy here would be worse than no copy. So the matching
# revision is fetched, our Dockerfile is placed into it, and the build runs
# there.
#
# Usage: ./build.sh [git-ref] [image-tag]
#   git-ref    revision of kyuz0/amd-strix-halo-comfyui-toolboxes (default: main)
#   image-tag  what to tag locally (default: comfyui-local)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REF="${1:-main}"
TAG="${2:-comfyui-local}"
REPO="https://github.com/kyuz0/amd-strix-halo-comfyui-toolboxes.git"

RUNTIME="podman"
command -v podman >/dev/null 2>&1 || RUNTIME="docker"
command -v "$RUNTIME" >/dev/null 2>&1 || { echo "Weder podman noch docker gefunden." >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "==> Hole Build-Kontext: $REPO @ $REF"
git clone --quiet --depth=1 --branch "$REF" "$REPO" "$WORK/ctx" 2>/dev/null || {
    # --branch does not take a commit SHA, so fall back to a full fetch for one.
    git clone --quiet "$REPO" "$WORK/ctx"
    git -C "$WORK/ctx" checkout --quiet "$REF"
}

SOURCE_REV="$(git -C "$WORK/ctx" rev-parse HEAD)"
echo "==> Revision: $SOURCE_REV"

cp "$HERE/Dockerfile.comfyui" "$WORK/ctx/Dockerfile.comfyui"

echo "==> Baue $TAG"
"$RUNTIME" build -t "$TAG" -f Dockerfile.comfyui "$WORK/ctx"

echo ""
echo "Fertig: $TAG (aus $SOURCE_REV)"
echo "Starten z. B. mit:"
echo "  $RUNTIME run -d --name comfyui \\"
echo "    --device /dev/dri --device /dev/kfd \\"
echo "    --group-add video --group-add render --security-opt seccomp=unconfined \\"
echo "    -p 8000:8000 \\"
echo "    -v \"\$HOME/comfy-models:/root/comfy-models:z\" \\"
echo "    -v \"\$HOME/comfy-outputs:/root/comfy-outputs:z\" \\"
echo "    $TAG"
