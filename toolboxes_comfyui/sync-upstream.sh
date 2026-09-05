#!/usr/bin/env bash
#
# Refreshes the vendored copies of scripts/ and workflows/ from the toolbox
# repository they came from.
#
# The build does not need this — everything is already here. It exists so the
# copies can be brought forward deliberately, and so the one file that must not
# be overwritten is protected: Dockerfile.comfyui carries this fork's CMD block,
# so upstream's version is only ever *reported*, never applied.
#
# Usage: ./sync-upstream.sh [git-ref]      (default: main)
#        ./sync-upstream.sh --check [ref]  report differences, change nothing

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="https://github.com/kyuz0/amd-strix-halo-comfyui-toolboxes.git"

CHECK_ONLY=0
if [[ "${1:-}" == "--check" ]]; then
    CHECK_ONLY=1
    shift
fi
REF="${1:-main}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "==> Hole $REPO @ $REF"
if ! git clone --quiet "$REPO" "$WORK/ctx" 2>/dev/null; then
    echo "Das Repository ist nicht erreichbar." >&2
    echo "Der Build läuft davon unabhängig weiter — siehe UPSTREAM.md." >&2
    exit 2
fi
git -C "$WORK/ctx" checkout --quiet "$REF"
REV="$(git -C "$WORK/ctx" rev-parse HEAD)"
echo "==> Revision: $REV"
echo ""

status=0

# The Dockerfile is ours below the CMD block, so it is compared but never
# copied. A change upstream is a prompt to port it by hand.
#
# Both sides are reduced to the part the two share: upstream without its final
# `CMD ["/bin/bash"]`, ours from FROM down to the separator that introduces this
# fork's block. Otherwise the one difference that is supposed to be there would
# be reported every single day.
upstream_common() { sed '/^CMD \["\/bin\/bash"\]$/d' "$WORK/ctx/Dockerfile"; }
ours_common() { sed -n '/^FROM /,/^# ----------/p' "$HERE/Dockerfile.comfyui" | sed '$d'; }

if ! diff -q <(upstream_common) <(ours_common) >/dev/null 2>&1; then
    echo "!! Upstreams Dockerfile weicht vom übernommenen Teil ab."
    echo "   Unterschiede (upstream < | hier >):"
    diff <(upstream_common) <(ours_common) | sed 's/^/     /' | head -40 || true
    echo "   Bitte von Hand übernehmen — der CMD-Block unten muss erhalten bleiben."
    echo ""
    status=1
else
    echo "== Dockerfile: übernommener Teil unverändert"
fi

for dir in scripts workflows; do
    if diff -rq "$WORK/ctx/$dir" "$HERE/$dir" >/dev/null 2>&1; then
        echo "== $dir/: unverändert"
        continue
    fi
    echo "== $dir/: Unterschiede"
    diff -rq "$WORK/ctx/$dir" "$HERE/$dir" | sed 's/^/     /' || true
    status=1
    if [[ $CHECK_ONLY -eq 0 ]]; then
        rm -rf "$HERE/$dir"
        cp -R "$WORK/ctx/$dir" "$HERE/$dir"
        echo "     → übernommen"
    fi
done

echo ""
if [[ $CHECK_ONLY -eq 1 ]]; then
    [[ $status -eq 0 ]] && echo "Alles auf Stand $REV." || echo "Abweichungen gefunden (Stand oben: $REV)."
else
    echo "Fertig. Trage $REV in UPSTREAM.md nach und prüfe die Änderungen vor dem Commit."
fi
exit $status
