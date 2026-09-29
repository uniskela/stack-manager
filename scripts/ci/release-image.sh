#!/usr/bin/env bash
# Helpers for .github/workflows/publish-image.yml (kept here so the logic can be tested locally).
#
#   release-image.sh digest IMAGE:TAG        Print the manifest digest of IMAGE:TAG, or nothing if it does not exist.
#   release-image.sh highest [PREFIX]        Print the highest vX.Y.Z git tag, optionally limited to PREFIX
#                                            (e.g. "v1.4." for the highest patch of 1.4).
set -euo pipefail

cmd="${1:-}"
shift || true

case "$cmd" in
  digest)
    ref="${1:?image reference required}"
    # A missing tag is not an error here: callers treat empty output as "does not exist".
    if out="$(docker buildx imagetools inspect "$ref" --format '{{json .Manifest}}' 2>/dev/null)"; then
      jq -r '.digest // empty' <<<"$out"
    fi
    ;;
  highest)
    prefix="${1:-v}"
    git tag --list "${prefix}*" | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -n 1 || true
    ;;
  *)
    echo "usage: $0 digest IMAGE:TAG | highest [PREFIX]" >&2
    exit 2
    ;;
esac
