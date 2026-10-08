# AGENTS.md

Guidance for coding agents working on **stack-manager**.

## Product boundary

Read [docs/public/PRODUCT.md](docs/public/PRODUCT.md) and [docs/internal/adr/0005-product-boundary.md](docs/internal/adr/0005-product-boundary.md) before adding features.

This app manages Git-backed **source/configuration** for Compose stacks. It is **not** a Portainer/Komodo/Arcane replacement. No Containers/Images/Networks/Volumes management pages. Runtime is optional and read-only.

## Current phase

**PR #5 — Deployment routing** is the next active product phase (DeploymentProvider, Portainer/generic webhooks,
forge webhook receiver, relevance rules, selective deploy). PR #2 (application foundation), PR #3 (source workspace)
and PR #4 (Git workflow: commit, safe push, conflict protection, stack history, Changes UI; released in v0.5.0) are
done. Do not build secrets providers, runtime watch or PWA work ahead of their phases.

See [docs/public/plans/MVP_PLAN.md](docs/public/plans/MVP_PLAN.md) and the code layout in
[docs/public/ARCHITECTURE.md](docs/public/ARCHITECTURE.md#code-layout-implemented-in-pr-2-extended-through-v050).

## Working in the code

- `pnpm check` must pass (format, lint, typecheck, tests). `pnpm build` must succeed.
- PR titles (and so squash-merge commits) must be Conventional Commits (`feat:`, `fix:`, `docs:`, …); Release
  Please derives versions and the changelog from them. See [docs/public/RELEASING.md](docs/public/RELEASING.md).
- Schema changes: edit `src/server/persistence/schema.ts`, run `pnpm db:generate`, commit the migration.
- API routes: always wrap handlers with `defineRoute` (auth is default-deny; a coverage test enforces this).
- Services receive dependencies through `src/server/container.ts`; depend on ports, not Drizzle.
- Never return credential ciphertext/plaintext from APIs; decrypt only via `CredentialService.withPlaintext`.
- Pass anything user- or provider-derived through the redacting logger/audit APIs; job payloads carry ids only.
- Run `git` only through `GitCli` (argv arrays, hardened env, protocol allowlist).
- Read repository content through `SourceTreeReader` (Git objects, never the working tree). Never return the
  contents of secret-looking files (`isSecretPath` in `src/shared/source/paths.ts`) or accept drafts for them.
- `src/shared` is pure code shared by server and browser (no Node, React or server imports; lint-enforced).
- User docs are published to uniskela.com from `docs/manifest.json` (see `.github/docs-sync.md`). Write them under
  `docs/public/` (setup, deployment, backups, security and other user-facing references). Implementation plans and
  architecture decisions go under `docs/internal/`. Agent-only notes go under `docs/agents/`; this file stays the
  canonical agent guide. When a feature changes what users see, update `docs/public/getting-started.md` /
  `docs/public/installation.md` and list new pages in the manifest. Do not change published slugs.
- UI tests: `pnpm build && pnpm test:e2e` (set `E2E_GIT_REMOTE`/`E2E_STACK_ROOT` to a public repo and stack folder to include the editor tests).

## Tech direction (locked)

- Next.js + TypeScript + Drizzle + SQLite (Postgres-ready ports)
- Modular monolith, long-running Docker Node (not serverless)
- Persisted DB jobs (no Redis unless justified)
- CodeMirror 6 preferred for editors
- Capability providers: Git / Deployment / Runtime / Secret

## Prior art

`uniskela/stackwise` is an unrelated inventory SPA. Do not import its code. See [docs/internal/PRIOR_ART.md](docs/internal/PRIOR_ART.md).

## Security

Never log or commit credentials. Encrypt provider secrets at rest. Redact audit events. See [docs/public/SECURITY.md](docs/public/SECURITY.md).

## Docs map

[docs/internal/INDEX.md](docs/internal/INDEX.md)
