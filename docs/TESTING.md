# Testing strategy

## Goals

Protect product boundary, credential safety, routing correctness, and editor/workflow regressions without requiring a live Portainer in every unit test.

## Layers

| Layer | Scope | Tools (planned) |
| --- | --- | --- |
| Unit | Relevance rules, redaction, URL validation, pure domain | Vitest / Node test runner |
| Integration | Drizzle repos, job worker, webhook verify | Test DB file / temp dirs |
| Contract | Provider adapters with mocked HTTP | MSW or undici mock |
| E2E | Auth, edit, commit (local git), routing explanations | Playwright |
| Manual | Real Portainer/Gitea in homelab | Documented checklist |

## Must-have test themes

1. **Product boundary:** Runtime adapter module cannot call forbidden Portainer endpoints (allowlist test / static check)
2. **Routing:** include/exclude/deps fixtures (LiftLog/Blinko/Immich example)
3. **Idempotency:** duplicate webhook delivery does not double deploy
4. **Redaction:** logs/audit serializers strip secrets
5. **Credentials API:** GET never returns secret material
6. **SSRF:** blocked addresses rejected
7. **Watch:** state machine transitions with mocked runtime snapshots
8. **Git:** conflict when remote ahead (fixture repos)

## Implemented in PR #2

- **Vitest** unit and integration tests (`tests/unit`, `tests/integration`) run against real SQLite files with
  real migrations, real AES-GCM/Argon2id and the real `git` binary.
- Git integration tests use a local smart-HTTP server (`git http-backend` behind Node `http`, with Basic auth);
  `https://git.test/…` remotes are rewritten to it via `url.<base>.insteadOf`, so the production URL validation and
  auth-header path are exercised end to end.
- API route handlers are invoked directly with `Request` objects; a coverage test asserts every handler uses
  `defineRoute` and that only allowlisted routes are public.
- `scripts/smoke.sh` drives a running instance over HTTP (setup, CSRF, auth, workspace, credential masking,
  optional public clone, logout); CI runs it against the production build and checks the Docker image boots healthy.
- Playwright E2E remains planned for editor flows (PR #3+).

## CI

- Lint, typecheck, unit/integration on PR
- E2E smoke on main or nightly if heavy
- CodeRabbit / review bots expected on GitHub PRs

## What we do not require in CI

- Live Infisical / Portainer credentials
- Docker socket access

## Fixtures

- Tiny compose monorepo under `testdata/`
- Recorded Portainer HTTP fixtures (sanitised)

## Performance smoke

- Open 5k-line compose in CodeMirror on mobile viewport (manual or Playwright)
