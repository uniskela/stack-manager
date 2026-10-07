# Documentation index

Architecture, planning and operations docs for **stack-manager**. User documentation starts at [index.md](index.md)
and is published at [uniskela.com/docs/stack-manager](https://uniskela.com/docs/stack-manager/); the pages it publishes
are listed in [manifest.json](manifest.json) (see [../.github/docs-sync.md](../.github/docs-sync.md)).

## User guide

| Doc | Summary |
| --- | --- |
| [index.md](index.md) | Overview: what stack-manager does and does not do |
| [installation.md](installation.md) | Docker Compose install, image tags, upgrades |
| [getting-started.md](getting-started.md) | First run, repositories, stacks, editor and drafts |

## Product and architecture

| Doc | Summary |
| --- | --- |
| [PRODUCT.md](PRODUCT.md) | Definition, hierarchy, non-goals, success criteria |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Modular monolith, providers, request flows |
| [PRIOR_ART.md](PRIOR_ART.md) | Portainer, Komodo, Arcane, Dockge, stackwise, etc. |
| [plans/MVP_PLAN.md](plans/MVP_PLAN.md) | PR #2–#8 implementation sequence |
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
| [STACK_DISCOVERY.md](STACK_DISCOVERY.md) | Repository → stack scopes |
| [DEPLOYMENT_ROUTING.md](DEPLOYMENT_ROUTING.md) | Path relevance and push router |
| [GIT_WORKFLOW.md](GIT_WORKFLOW.md) | Edit → validate → commit → push |
| [DEPLOYMENT_WATCH.md](DEPLOYMENT_WATCH.md) | CI-like deploy feedback |

## Operations and UX

| Doc | Summary |
| --- | --- |
| [SELF_HOSTING.md](SELF_HOSTING.md) | Configuration, data directory, Docker, upgrades |
| [RELEASING.md](RELEASING.md) | CI workflows, Conventional Commits, Release Please, GHCR images |
| [AUTH_AND_CREDENTIALS.md](AUTH_AND_CREDENTIALS.md) | Auth, encryption at rest |
| [SECURITY.md](SECURITY.md) | Threat model and controls |
| [UX.md](UX.md) | Desktop / mobile / PWA |
| [BACKUP_RESTORE.md](BACKUP_RESTORE.md) | Backup and restore |
| [TESTING.md](TESTING.md) | Testing strategy |

## Architecture decision records

| ADR | Decision |
| --- | --- |
| [adr/0001-tech-stack.md](adr/0001-tech-stack.md) | Next.js, TS, Drizzle, SQLite |
| [adr/0002-persisted-jobs.md](adr/0002-persisted-jobs.md) | Lightweight job table (no Redis MVP) |
| [adr/0003-editor-codemirror.md](adr/0003-editor-codemirror.md) | CodeMirror 6 preferred |
| [adr/0004-modular-monolith.md](adr/0004-modular-monolith.md) | Single deployable Node service |
| [adr/0005-product-boundary.md](adr/0005-product-boundary.md) | Source workspace, not container manager |
