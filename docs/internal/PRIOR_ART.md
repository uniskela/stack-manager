# Prior art and competitors

This document positions **stack-manager** against adjacent tools. It is analysis only; no code is imported from any prior project.

## Positioning matrix

| System | Primary job | Relation to stack-manager |
| --- | --- | --- |
| **Portainer** | Docker/K8s container & stack ops UI | Downstream Deployment (webhook) and/or Runtime (API, read-only) |
| **Komodo** | Deploy/ops for containers & servers | Future Deployment + Runtime providers |
| **Arcane** | Container/ops management | Future provider candidate |
| **Dockge** | Compose stack UI closer to files | Overlaps editing; still more ops-oriented; not Git-router |
| **Docker Compose CLI / Docker** | Local runtime | Out of scope as management plane |
| **Coolify / CapRover** | PaaS-style deploy from Git | Different product; may inspire webhook patterns only |
| **Renovate / Dependabot** | Dependency PRs | Orthogonal; may appear in same repos |
| **UniHomelabDash** | Homelab control-plane PWA | Sibling product; container control centre — **do not merge identities** |
| **stackwise** (uniskela) | Inventory SPA (unrelated) | Name collision only — see below |

## Portainer

**What it does well:** environment management, stacks, containers, logs, credentials scoped to Portainer users.

**What stack-manager will use:**

- **Deployment:** Portainer stack webhooks (URL only; no API token required merely to trigger).
- **Runtime (optional):** Portainer API token for read-only observation (test connection, environments, stack/container state, images, health, restarts, recent logs, deep-links).

**What stack-manager will not do:** expose destructive Docker controls even if a token could permit them. Portainer remains the management system; this app observes it.

**Security note:** Portainer API tokens inherit the permissions of the Portainer user. Recommend a dedicated least-privilege integration identity. Document this in credentials UI and security docs.

## Komodo / Arcane

Treat as future provider backends behind the same capability interfaces. Core domain must not hard-code Portainer concepts (IDs may appear only inside provider-specific binding config).

## Dockge and Compose-file UIs

Useful reference for compose-centric editing UX. stack-manager differentiates by:

1. Git as the workspace authority
2. Multi-stack monorepo scopes + push routing
3. Explicit deployment and runtime provider bindings
4. Secret provider metadata integration
5. Deployment Watch / failure correlation

## UniHomelabDash

Existing Uniskela project: self-hosted homelab dashboard / control-plane PWA with health checks and eventual ops features.

**Do not** reuse its product narrative (“control centre for containers”) for stack-manager. Patterns worth studying later (self-host Docker, SQLite, auth) are optional references only — not a fork base for PR #1.

## stackwise (uniskela/stackwise) — prior art inspection

Inspected 2026-09-28 from `https://github.com/uniskela/stackwise`.

### What it attempted

- Branding: **Stackwise** inventory management application
- Tech: TanStack Start / Vite / React / TypeScript, Cloudflare Workers path + Coolify/nginx static Docker path
- Domain: catalog, stock movements, suppliers, purchase orders, locations, RBAC demo mode, analytics, AI reorder/anomaly PRDs
- Docs: extensive PRD JSON set (PRD-01 … PRD-28), SQL migrations for inventory schema
- Status per `docs/progress.md`: all 28 PRDs marked complete (demo-oriented)

### Useful ideas to carry forward (ideas only)

- Mobile-first shell (bottom nav + “More” sheet at small breakpoints)
- Command palette as power-user navigation
- Explicit PRD/ADR-style phase documentation discipline
- Demo-mode thinking for onboarding (optional later; not MVP-critical)

### Reusable code?

**No.** Different product domain, different runtime (SPA/Workers vs self-hosted Next monolith), different data model. Do **not** import or copy source automatically.

### Architecture conflict with stack-manager goals?

**Yes, if confused by name.** stackwise is an inventory app, not a Compose/Git source workspace. Its Cloudflare/Workers-oriented paths conflict with stack-manager’s long-running Docker Node requirement. Coolify static nginx packaging is also the wrong shape for webhook workers + encrypted credential storage.

### Licensing / provenance

- Repository had **no `LICENSE` file** at inspection time.
- Private Uniskela provenance; still treat as **non-reusable** without an explicit license decision and deliberate extraction.
- stack-manager uses **MIT** independently; do not assume stackwise code can be copied into this tree.

### Naming

Retain product/repo name **stack-manager**. Do not revive “stackwise” / “stack-ui” as canonical names. Mention stackwise only as prior-art collision.

## Competitive summary

stack-manager wins when the user pain is:

> “My Compose lives in Git across many stacks; I want to edit safely, deploy only what changed, and see if runtime accepted it — without living inside Portainer for source work.”

It loses (and should defer) when the user pain is:

> “I need to manage containers, networks, volumes, and exec into hosts.”
