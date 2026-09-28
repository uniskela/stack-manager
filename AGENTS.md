# AGENTS.md

Guidance for coding agents working on **stack-manager**.

## Product boundary

Read [docs/PRODUCT.md](docs/PRODUCT.md) and [docs/adr/0005-product-boundary.md](docs/adr/0005-product-boundary.md) before adding features.

This app manages Git-backed **source/configuration** for Compose stacks. It is **not** a Portainer/Komodo/Arcane replacement. No Containers/Images/Networks/Volumes management pages. Runtime is optional and read-only.

## Current phase

**PR #1 — architecture docs only.** Do not scaffold the production app until PR #2.

See [docs/plans/MVP_PLAN.md](docs/plans/MVP_PLAN.md).

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
