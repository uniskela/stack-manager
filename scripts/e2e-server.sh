#!/usr/bin/env bash
# Starts a throwaway production server for the Playwright UI tests (used by playwright.config.ts).
# Requires `pnpm build` first. Every run gets a fresh data directory and fresh keys, so first-run setup
# is always pending.
set -euo pipefail

[[ -f .next/standalone/server.js ]] || { echo "Run pnpm build first." >&2; exit 1; }
rm -rf .next/standalone/.next/static
cp -r .next/static .next/standalone/.next/static

STACK_MANAGER_DATA_DIR="$(mktemp -d)"
STACK_MANAGER_ENCRYPTION_KEY="$(openssl rand -base64 32)"
STACK_MANAGER_SESSION_SECRET="$(openssl rand -base64 48)"
export STACK_MANAGER_DATA_DIR STACK_MANAGER_ENCRYPTION_KEY STACK_MANAGER_SESSION_SECRET
export STACK_MANAGER_COOKIE_SECURE=false HOSTNAME=127.0.0.1 PORT="${PORT:-3100}"
exec node .next/standalone/server.js
