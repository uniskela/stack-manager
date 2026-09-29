#!/usr/bin/env bash
# Helpers for .github/workflows/publish-image.yml (kept here so the logic can be tested locally).
#
#   release-image.sh digest IMAGE:TAG        Print the manifest digest of IMAGE:TAG, nothing if the tag does not
#                                            exist, or fail if the registry cannot be queried.
#   release-image.sh highest [PREFIX]        Print the highest vX.Y.Z git tag, optionally limited to PREFIX
#                                            (e.g. "v1.4." for the highest patch of 1.4).
set -euo pipefail

cmd="${1:-}"
shift || true

case "$cmd" in
  digest)
    ref="${1:?image reference required}"
    # Only a confirmed missing tag prints nothing (callers treat that as "does not exist"). Any other
    # failure (auth, rate limit, network) must stop the caller, or it would rebuild a published release.
    if out="$(docker buildx imagetools inspect "$ref" --format '{{json .Manifest}}' 2>&1)"; then
      digest="$(jq -r '.digest // empty' <<<"$out")"
      [[ -n "$digest" ]] || { echo "no digest in manifest of $ref" >&2; exit 1; }
      echo "$digest"
    elif grep -qE ': not found$' <<<"$out"; then
      exit 0
    else
      echo "cannot inspect $ref: $out" >&2
      exit 1
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
