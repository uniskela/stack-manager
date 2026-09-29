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
2. **Routing:** include/exclude/deps fixtures (Wiki/Notes/Photos example)
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
- **Playwright UI tests** (`tests/e2e`, `pnpm build && pnpm test:e2e`) run against a throwaway production server
  (`scripts/e2e-server.sh`): first-run onboarding, navigation, validation, 404 and sign-in/out at desktop (1280 px)
  and mobile (Pixel 7) sizes. Every page is checked with axe for serious/critical WCAG 2.2 A/AA violations in both
  light and dark colour schemes. CI runs them after the smoke test.
- **Source workspace (PR #3):** integration tests against a real Git server cover discovery, stack CRUD, workspace
  isolation, secret/symlink locking, path escapes, draft save/discard, size limits and upstream-change detection;
  unit tests cover path rules and the Compose analyser. With `E2E_GIT_REMOTE` and `E2E_STACK_ROOT` set (CI uses
  `docker/awesome-compose` / `nginx-golang`, since the remote must be public), the
  Playwright suite also opens the editor, saves a draft, reviews the diff and checks every stack tab with axe.

## CI

See [RELEASING.md](RELEASING.md) for the full workflow list. On every PR: workflow lint (actionlint +
shellcheck), format/lint/typecheck/unit+integration tests, migration drift, build, HTTP smoke test, Playwright + axe,
production dependency audit, Docker image boot test, secret scan (gitleaks) and a Conventional Commit title check.
PRs touching the image also run the container security scan (Trivy).

## What we do not require in CI

- Live Infisical / Portainer credentials
- Docker socket access

## Fixtures

- Tiny compose monorepo under `testdata/`
- Recorded Portainer HTTP fixtures (sanitised)

## Performance smoke

- Open 5k-line compose in CodeMirror on mobile viewport (manual or Playwright)
