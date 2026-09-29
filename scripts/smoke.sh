#!/usr/bin/env bash
# End-to-end smoke test against a running stack-manager (production build or Docker container).
#   BASE_URL=http://127.0.0.1:3000 scripts/smoke.sh
# Optional: SMOKE_REMOTE=https://github.com/<org>/<public-repo>.git to exercise a real public clone.
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT
PASS="smoke-test-passphrase-$RANDOM$RANDOM"

fail() { echo "FAIL: $*" >&2; exit 1; }
status() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
post() { curl -s -b "$JAR" -c "$JAR" -H 'Content-Type: application/json' -H "Origin: $BASE_URL" -X "${3:-POST}" -d "$2" "$BASE_URL$1"; }

echo "→ health"
[[ "$(curl -s "$BASE_URL/api/health")" == '{"status":"ok"}' ]] || fail "health"

echo "→ first run redirects to /setup"
loc=$(curl -s -o /dev/null -w '%{redirect_url}' "$BASE_URL/")
[[ "$loc" == *"/setup" ]] || fail "expected redirect to /setup, got $loc"

echo "→ protected API is blocked while anonymous"
[[ "$(status "$BASE_URL/api/workspaces")" == 401 ]] || fail "anonymous /api/workspaces"

echo "→ cross-origin setup is rejected"
[[ "$(status -H 'Content-Type: application/json' -H 'Origin: https://evil.example' -d '{"username":"admin","password":"x"}' "$BASE_URL/api/setup")" == 403 ]] || fail "csrf"

echo "→ create admin"
out=$(post /api/setup "{\"username\":\"admin\",\"password\":\"$PASS\"}")
[[ "$out" == *'"username":"admin"'* ]] || fail "setup: $out"
grep -q 'sm_session' "$JAR" || fail "no session cookie"
grep -q '#HttpOnly_' "$JAR" || fail "session cookie is not HttpOnly"

echo "→ setup cannot run twice"
[[ "$(status -H 'Content-Type: application/json' -H "Origin: $BASE_URL" -d "{\"username\":\"x2\",\"password\":\"$PASS\"}" "$BASE_URL/api/setup")" == 409 ]] || fail "second setup"

echo "→ onboarding page renders for the admin"
[[ "$(status -b "$JAR" "$BASE_URL/onboarding")" == 200 ]] || fail "onboarding"

echo "→ create workspace"
ws=$(post /api/workspaces '{"name":"Smoke"}')
wsid=$(sed -E 's/.*"id":"([^"]+)".*/\1/' <<<"$ws")
[[ -n "$wsid" && "$ws" == *'"slug":"smoke"'* ]] || fail "workspace: $ws"
[[ "$(status -b "$JAR" "$BASE_URL/w/$wsid")" == 200 ]] || fail "workspace page"
[[ "$(status -b "$JAR" "$BASE_URL/w/$wsid/repositories/new")" == 200 ]] || fail "connect page"
[[ "$(status -b "$JAR" "$BASE_URL/w/$wsid/settings")" == 200 ]] || fail "settings page"

echo "→ credential API never returns the secret"
cred=$(post "/api/workspaces/$wsid/credentials" '{"kind":"git","providerType":"github","label":"Smoke","secret":"ghp_smokeSecretValue1234567890abcd"}')
[[ "$cred" != *smokeSecretValue* && "$cred" == *'"hint":"••••abcd"'* ]] || fail "credential create: $cred"
list=$(curl -s -b "$JAR" "$BASE_URL/api/workspaces/$wsid/credentials")
[[ "$list" != *smokeSecretValue* && "$list" != *iphertext* ]] || fail "credential list leaked: $list"

if [[ -n "${SMOKE_REMOTE:-}" ]]; then
  echo "→ connect public repository $SMOKE_REMOTE"
  repo=$(post "/api/workspaces/$wsid/repositories" "{\"gitProviderType\":\"github\",\"remoteUrl\":\"$SMOKE_REMOTE\",\"auth\":{\"type\":\"none\"}}")
  rid=$(sed -E 's/^\{"repository":\{"id":"([^"]+)".*/\1/' <<<"$repo")
  [[ -n "$rid" && "$repo" == *'"syncStatus"'* ]] || fail "connect: $repo"
  for _ in $(seq 1 60); do
    detail=$(curl -s -b "$JAR" "$BASE_URL/api/workspaces/$wsid/repositories/$rid")
    [[ "$detail" == *'"syncStatus":"ready"'* ]] && break
    [[ "$detail" == *'"syncStatus":"error"'* ]] && fail "sync error: $detail"
    sleep 1
  done
  [[ "$detail" == *'"syncStatus":"ready"'* ]] || fail "sync did not finish: $detail"
  echo "  cloned; head $(sed -E 's/.*"headSha":"([0-9a-f]{12}).*/\1/' <<<"$detail")"
fi

echo "→ logout invalidates the session"
post /api/auth/logout '{}' >/dev/null
[[ "$(status -b "$JAR" "$BASE_URL/api/workspaces")" == 401 ]] || fail "session still valid after logout"
loc=$(curl -s -b "$JAR" -o /dev/null -w '%{redirect_url}' "$BASE_URL/w/$wsid")
[[ "$loc" == *"/login" ]] || fail "expected redirect to /login, got $loc"

echo "✓ smoke test passed"
