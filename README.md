# stack-manager

**Git-native source workspace for self-hosted Compose infrastructure, with deployment awareness.**

stack-manager helps you edit and manage Docker Compose Git repositories: stacks, docs, environment references, and secret references. When you commit a change, it can deploy **only the affected stacks** through Portainer (or another deployment system), then optionally watch runtime state to tell you whether the change worked.

It is **not** a Portainer / Komodo / Arcane / Docker UI replacement. Those systems remain responsible for containers. This application manages **source and Git workflow**, with optional read-only runtime context.

> I edit and manage my Docker Compose Git repo through this app. It understands my stacks, docs, environment variables and secrets. When I commit something, it deploys only the stack I changed through Portainer/another deployment system, then watches the runtime to tell me whether my change worked.

## Status

**PR #2 — application foundation.** A runnable, self-hosted foundation: first-run admin setup, sessions,
workspaces, encrypted provider credentials, Git repository connections (GitHub / Gitea / Forgejo over HTTPS)
with background clone/fetch, a persisted job queue, and a redacted audit trail.

Stack scopes, editors and the Git commit workflow arrive in later PRs — see
[docs/plans/MVP_PLAN.md](docs/plans/MVP_PLAN.md).

| Document | Purpose |
| --- | --- |
| [docs/PRODUCT.md](docs/PRODUCT.md) | Product definition, goals, non-goals |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System architecture and code layout |
| [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md) | Configuration, data directory, Docker, upgrades |
| [docs/plans/MVP_PLAN.md](docs/plans/MVP_PLAN.md) | Phased PR implementation sequence |
| [docs/INDEX.md](docs/INDEX.md) | Full documentation index |

## Quick start (Docker Compose)

```bash
cp .env.example .env
# Fill in the two required secrets:
#   STACK_MANAGER_ENCRYPTION_KEY=$(openssl rand -base64 32)
#   STACK_MANAGER_SESSION_SECRET=$(openssl rand -base64 48)
docker compose up -d --build
```

Open `http://<host>:3000` and follow the setup: **admin account → workspace → repository**.
Put stack-manager behind a TLS-terminating reverse proxy and set `STACK_MANAGER_PUBLIC_URL`.
For plain-HTTP testing on localhost set `STACK_MANAGER_COOKIE_SECURE=false`.

The container runs as a non-root user with a read-only root filesystem; all state lives in the `/data`
volume. No Docker socket is mounted. See [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md).

## Development

Requires Node.js 22.12+ (24 recommended), pnpm 9 and `git`.

```bash
pnpm install
cp .env.example .env   # set the secrets; STACK_MANAGER_DATA_DIR=./data is fine for dev
set -a && . ./.env && set +a
pnpm dev               # http://localhost:3000 (set STACK_MANAGER_COOKIE_SECURE=false)
```

| Command | Purpose |
| --- | --- |
| `pnpm check` | Format check, lint, typecheck, tests |
| `pnpm test` | Unit + integration tests (Vitest; real SQLite, real `git` against a local smart-HTTP server) |
| `pnpm build` | Production build (`.next/standalone`) |
| `pnpm db:generate` | Generate a Drizzle migration after editing `src/server/persistence/schema.ts` |
| `pnpm db:migrate` | Apply migrations manually (they also run automatically at startup) |
| `scripts/smoke.sh` | End-to-end HTTP smoke test against a running instance |

## Tech stack

- Self-hosted **Next.js (App Router) + TypeScript** modular monolith, long-running Node (not serverless)
- **Drizzle ORM** + **SQLite** behind repository ports (PostgreSQL-ready)
- Persisted job table with an in-process, lease-based worker (no Redis)
- Capability-based **Git / Deployment / Runtime / Secret** providers (Git implemented in PR #2)
- **CodeMirror 6** preferred for editors (PR #3)

## License

MIT — see [LICENSE](LICENSE).
