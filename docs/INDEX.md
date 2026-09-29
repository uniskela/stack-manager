# Documentation index

Architecture and planning for **stack-manager** (PR #1 — docs only).

## Product and architecture

| Doc | Summary |
| --- | --- |
| [PRODUCT.md](PRODUCT.md) | Definition, hierarchy, non-goals, success criteria |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Modular monolith, providers, request flows |
| [PRIOR_ART.md](PRIOR_ART.md) | Portainer, Komodo, Arcane, Dockge, stackwise, etc. |
| [plans/MVP_PLAN.md](plans/MVP_PLAN.md) | PR #2–#8 implementation sequence |

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
