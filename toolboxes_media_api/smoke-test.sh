#!/usr/bin/env bash
#
# Starts the image in mock mode (no GPU, no weights) and drives it end to end:
# health, authentication (API key and browser login + CSRF), one image job,
# one edit job, one video job, and their results. Leaves nothing behind.
#
# Usage: ./smoke-test.sh [image]   (default: media-api-local)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="${1:-media-api-local}"
RUNTIME="podman"
command -v podman >/dev/null 2>&1 || RUNTIME="docker"
NAME="media-api-smoke-$$"
PORT="${SMOKE_PORT:-18100}"
KEY="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
DATA="$(mktemp -d)"
trap '"$RUNTIME" rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$DATA"' EXIT

echo "==> Ohne Schlüssel muss der Start scheitern"
if "$RUNTIME" run --rm "$IMAGE" >/dev/null 2>&1; then
  echo "✗ Container startete ohne MEDIA_API_KEY" >&2
  exit 1
fi
echo "  ✓ verweigert"

echo "==> Starte $IMAGE im Mock-Modus auf Port $PORT"
"$RUNTIME" run -d --name "$NAME" -p "127.0.0.1:$PORT:8100" \
  -e MEDIA_API_KEY="$KEY" -e MEDIA_BACKEND=mock -e MEDIA_MOCK_STEP_SECONDS=0.01 \
  -v "$DATA:/data:Z" "$IMAGE" >/dev/null

MEDIA_API_KEY="$KEY" python3 "$HERE/tests/smoke_client.py" "http://127.0.0.1:$PORT" || {
  echo "--- Container-Log ---" >&2
  "$RUNTIME" logs "$NAME" 2>&1 | tail -40 >&2
  exit 1
}
