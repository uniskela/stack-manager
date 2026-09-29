# AGENTS.md

Guidance for coding agents working on **stack-manager**.

## Product boundary

Read [docs/PRODUCT.md](docs/PRODUCT.md) and [docs/adr/0005-product-boundary.md](docs/adr/0005-product-boundary.md) before adding features.

This app manages Git-backed **source/configuration** for Compose stacks. It is **not** a Portainer/Komodo/Arcane replacement. No Containers/Images/Networks/Volumes management pages. Runtime is optional and read-only.

## Current phase

**PR #2 — application foundation** (scaffold, auth, DB, encrypted credentials, workspace/repository model,
Git connection, persisted jobs, audit, Docker). Next up: **PR #3 — source workspace**. Do not build features
from later PRs ahead of their phase.

See [docs/plans/MVP_PLAN.md](docs/plans/MVP_PLAN.md) and the code layout in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#code-layout-implemented-in-pr-2).

## Working in the code

- `pnpm check` must pass (format, lint, typecheck, tests). `pnpm build` must succeed.
- Schema changes: edit `src/server/persistence/schema.ts`, run `pnpm db:generate`, commit the migration.
- API routes: always wrap handlers with `defineRoute` (auth is default-deny; a coverage test enforces this).
- Services receive dependencies through `src/server/container.ts`; depend on ports, not Drizzle.
- Never return credential ciphertext/plaintext from APIs; decrypt only via `CredentialService.withPlaintext`.
- Pass anything user- or provider-derived through the redacting logger/audit APIs; job payloads carry ids only.
- Run `git` only through `GitCli` (argv arrays, hardened env, protocol allowlist).

## Tech direction (locked)

- Next.js + TypeScript + Drizzle + SQLite (Postgres-ready ports)
- Modular monolith, long-running Docker Node (not serverless)
- Persisted DB jobs (no Redis unless justified)
- CodeMirror 6 preferred for editors
- Capability providers: Git / Deployment / Runtime / Secret

## Prior art

`uniskela/stackwise` is an unrelated inventory SPA. Do not import its code. See [docs/PRIOR_ART.md](docs/PRIOR_ART.md).

## Security

Never log or commit credentials. Encrypt provider secrets at rest. Redact audit events. See [docs/SECURITY.md](docs/SECURITY.md).

## Docs map

[docs/INDEX.md](docs/INDEX.md)
