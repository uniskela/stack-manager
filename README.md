# stack-manager

**Git-native source workspace for self-hosted Compose infrastructure, with deployment awareness.**

stack-manager helps you edit and manage Docker Compose Git repositories: stacks, docs, environment references, and secret references. When you commit a change, it can deploy **only the affected stacks** through Portainer (or another deployment system), then optionally watch runtime state to tell you whether the change worked.

It is **not** a Portainer / Komodo / Arcane / Docker UI replacement. Those systems remain responsible for containers. This application manages **source and Git workflow**, with optional read-only runtime context.

> I edit and manage my Docker Compose Git repo through this app. It understands my stacks, docs, environment variables and secrets. When I commit something, it deploys only the stack I changed through Portainer/another deployment system, then watches the runtime to tell me whether my change worked.

## Status

Early development (0.x).

**Already available:** first-run setup, workspaces, encrypted credentials, Git repository connections
(GitHub / Gitea / Forgejo over HTTPS), stacks, dashboard, organised Stacks list, settings, a VS Code-style editor with
drafts and Compose validation, stack docs, an environment inventory, and change review (diffs).

**Coming in v0.5.0:** committing drafts, safe push, and Git history. Deployment routing (deploy only the stacks a
commit changed) follows the Git workflow phase; see the [roadmap](docs/plans/MVP_PLAN.md).

**Documentation:** [uniskela.com/docs/stack-manager](https://uniskela.com/docs/stack-manager/) (source in
[docs/](docs/index.md)).

| Document | Purpose |
| --- | --- |
| [Installation](docs/installation.md) | Run the published container image with Docker Compose |
| [Getting started](docs/getting-started.md) | First run, connecting a repository, stacks and the editor |
| [Self-hosting reference](docs/SELF_HOSTING.md) | Configuration, data directory, reverse proxy, upgrades |
| [Product](docs/PRODUCT.md) / [Architecture](docs/ARCHITECTURE.md) | What it is (and is not), and how it is built |
| [Docs index](docs/INDEX.md) | Every design, planning and operations document |

## Quick start (Docker Compose)

```bash
git clone https://github.com/uniskela/stack-manager.git && cd stack-manager
cp .env.example .env
# Set the version and the two required secrets:
#   STACK_MANAGER_VERSION=0.1.0
#   STACK_MANAGER_ENCRYPTION_KEY=$(openssl rand -base64 32)
#   STACK_MANAGER_SESSION_SECRET=$(openssl rand -base64 48)
docker compose up -d
```

This pulls `ghcr.io/uniskela/stack-manager`. To build your checkout instead, run
`docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build`.

Open `http://localhost:3000` (the port is published on localhost only; see `STACK_MANAGER_BIND`) and follow the setup: **admin account → workspace → repository**.
Put stack-manager behind a TLS-terminating reverse proxy and set `STACK_MANAGER_PUBLIC_URL`.
For plain-HTTP testing on localhost set `STACK_MANAGER_COOKIE_SECURE=false`.

The container runs as a non-root user with a read-only root filesystem; all state lives in the `/data`
volume. No Docker socket is mounted. See [docs/installation.md](docs/installation.md).

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
- Capability-based **Git / Deployment / Runtime / Secret** providers (Git implemented)
- **CodeMirror 6** editor

## License

MIT — see [LICENSE](LICENSE).
