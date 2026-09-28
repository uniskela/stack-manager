# stack-manager

**Git-native source workspace for self-hosted Compose infrastructure, with deployment awareness.**

stack-manager helps you edit and manage Docker Compose Git repositories: stacks, docs, environment references, and secret references. When you commit a change, it can deploy **only the affected stacks** through Portainer (or another deployment system), then optionally watch runtime state to tell you whether the change worked.

It is **not** a Portainer / Komodo / Arcane / Docker UI replacement. Those systems remain responsible for containers. This application manages **source and Git workflow**, with optional read-only runtime context.

> I edit and manage my Docker Compose Git repo through this app. It understands my stacks, docs, environment variables and secrets. When I commit something, it deploys only the stack I changed through Portainer/another deployment system, then watches the runtime to tell me whether my change worked.

## Status

**PR #1 — product architecture and implementation plan (docs only).**  
No production application code is scaffolded in this phase.

Start here:

| Document | Purpose |
| --- | --- |
| [docs/PRODUCT.md](docs/PRODUCT.md) | Product definition, goals, non-goals |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System architecture overview |
| [docs/PRIOR_ART.md](docs/PRIOR_ART.md) | Competitors / prior art (incl. stackwise) |
| [docs/plans/MVP_PLAN.md](docs/plans/MVP_PLAN.md) | Phased PR implementation sequence |
| [docs/INDEX.md](docs/INDEX.md) | Full documentation index |

## Planned stack (post–PR #1)

- Self-hosted **Next.js + TypeScript** modular monolith
- **Drizzle ORM** with **SQLite** initially (PostgreSQL-ready persistence ports)
- Long-running **Docker** deployment (not serverless / not Vercel-shaped)
- Capability-based **Git / Deployment / Runtime / Secret** providers
- **CodeMirror 6** preferred for mobile-friendly editing (evaluate vs Monaco in ADR)

## License

MIT — see [LICENSE](LICENSE).
