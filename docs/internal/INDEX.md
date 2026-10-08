# Documentation index

Architecture, planning and operations docs for **stack-manager**. User documentation lives in
[public/](../public/index.md) and is published at
[uniskela.com/docs/stack-manager](https://uniskela.com/docs/stack-manager/); the pages it publishes
are listed in [manifest.json](../manifest.json) (see [docs-sync](../../.github/docs-sync.md)).

| Tree | What belongs there |
| --- | --- |
| [public/](../public/index.md) | Setup, deployment, backups, security and other user-facing references |
| internal/ (this file) | Implementation plans, architecture decisions and maintainer references |
| [agents/](../agents/README.md) | Agent notes. Canonical instructions stay in [AGENTS.md](../../AGENTS.md) |

## User guide

| Doc | Summary |
| --- | --- |
| [index.md](../public/index.md) | Overview: what stack-manager does and does not do |
| [installation.md](../public/installation.md) | Docker Compose install, image tags, upgrades |
| [getting-started.md](../public/getting-started.md) | First run, repositories, stacks, editor, drafts, commit and push |
| [GIT_WORKFLOW.md](../public/GIT_WORKFLOW.md) | Commit, safe push, remote changes, stack history; API reference |

## Product and architecture

| Doc | Summary |
| --- | --- |
| [PRODUCT.md](../public/PRODUCT.md) | Definition, hierarchy, non-goals, success criteria |
| [ARCHITECTURE.md](../public/ARCHITECTURE.md) | Modular monolith, providers, request flows |
| [PRIOR_ART.md](PRIOR_ART.md) | Portainer, Komodo, Arcane, Dockge, stackwise, etc. |
| [plans/MVP_PLAN.md](../public/plans/MVP_PLAN.md) | Published roadmap: PR #2–#8 sequence |
| [plans/UI_UX_PLAN.md](plans/UI_UX_PLAN.md) | UI/UX review of PR #2 and phased improvement plan |
| [plans/2026-09-30-dashboard-stacks-settings-design.md](plans/2026-09-30-dashboard-stacks-settings-design.md) | Dashboard home, organised stacks, settings split (slice A) |
| [plans/2026-09-30-dashboard-stacks-settings-implementation.md](plans/2026-09-30-dashboard-stacks-settings-implementation.md) | Implementation plan for slice A (nav, dashboard, stacks, settings, account) |
| [plans/2026-09-30-stacks-ui-audit-and-plan.md](plans/2026-09-30-stacks-ui-audit-and-plan.md) | Stacks list UX audit and S1–S5 plan (implemented) |

## Domain and providers

| Doc | Summary |
| --- | --- |
| [domain/DATA_MODEL.md](domain/DATA_MODEL.md) | Entities, bindings, jobs, audit |
| [providers/GIT_PROVIDER.md](providers/GIT_PROVIDER.md) | Git forge abstraction |
| [providers/DEPLOYMENT_PROVIDER.md](providers/DEPLOYMENT_PROVIDER.md) | Deploy-only providers |
| [providers/RUNTIME_PROVIDER.md](providers/RUNTIME_PROVIDER.md) | Optional read-only runtime |
| [providers/SECRET_PROVIDER.md](providers/SECRET_PROVIDER.md) | Secret metadata / references |
| [STACK_DISCOVERY.md](../public/STACK_DISCOVERY.md) | Repository → stack scopes |
| [DEPLOYMENT_ROUTING.md](DEPLOYMENT_ROUTING.md) | Path relevance and push router |
| [GIT_WORKFLOW.md](../public/GIT_WORKFLOW.md) | Edit → validate → commit → push → history (implemented in v0.5.0) |
| [DEPLOYMENT_WATCH.md](DEPLOYMENT_WATCH.md) | CI-like deploy feedback |

## Operations and UX

| Doc | Summary |
| --- | --- |
| [SELF_HOSTING.md](../public/SELF_HOSTING.md) | Configuration, data directory, Docker, upgrades |
| [RELEASING.md](../public/RELEASING.md) | CI workflows, Conventional Commits, Release Please, GHCR images |
| [AUTH_AND_CREDENTIALS.md](../public/AUTH_AND_CREDENTIALS.md) | Auth, encryption at rest |
| [SECURITY.md](../public/SECURITY.md) | Threat model and controls |
| [UX.md](UX.md) | Desktop / mobile / PWA |
| [BACKUP_RESTORE.md](../public/BACKUP_RESTORE.md) | Backup and restore |
| [TESTING.md](../public/TESTING.md) | Testing strategy |

## Architecture decision records

| ADR | Decision |
| --- | --- |
| [adr/0001-tech-stack.md](adr/0001-tech-stack.md) | Next.js, TS, Drizzle, SQLite |
| [adr/0002-persisted-jobs.md](adr/0002-persisted-jobs.md) | Lightweight job table (no Redis MVP) |
| [adr/0003-editor-codemirror.md](adr/0003-editor-codemirror.md) | CodeMirror 6 preferred |
| [adr/0004-modular-monolith.md](adr/0004-modular-monolith.md) | Single deployable Node service |
| [adr/0005-product-boundary.md](adr/0005-product-boundary.md) | Source workspace, not container manager |
