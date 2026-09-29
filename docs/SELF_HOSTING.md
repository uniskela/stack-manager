# Self-hosting

stack-manager ships as a single long-running Node.js container (see [adr/0004-modular-monolith.md](adr/0004-modular-monolith.md)).
It needs no database server, no Redis and **no Docker socket**.

## Container image

Every release publishes `ghcr.io/uniskela/stack-manager` (linux/amd64) with these tags:

| Tag | Meaning |
| --- | --- |
| `v1.2.3`, `1.2.3` | Immutable release |
| `1.2` | Latest patch of a minor line |
| `latest` | Newest release (promoted only after the release image passed its scan and smoke test) |
| `sha-abc1234` | The exact commit a release was built from |

Images carry an SBOM and build provenance, and are scanned with Trivy before publication (no fixable HIGH or
CRITICAL vulnerabilities). While the repository is private the package is private too: run
`docker login ghcr.io` with a token that has `read:packages` before pulling.

```sh
cp .env.example .env   # fill in the two secrets and set STACK_MANAGER_VERSION (e.g. 0.1.0)
docker compose up -d
```

`docker-compose.yml` requires an explicit `STACK_MANAGER_VERSION`, so an upgrade (and its migrations) only happens
when you change it. To run a build of your checkout instead, add the override:
`docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build`.

## Configuration

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `STACK_MANAGER_DATA_DIR` | yes | `/data` in the image | Persistent directory for SQLite and Git clones |
| `STACK_MANAGER_ENCRYPTION_KEY` | yes | — | 32 random bytes, base64 (`openssl rand -base64 32`). Encrypts provider credentials (AES-256-GCM) |
| `STACK_MANAGER_SESSION_SECRET` | yes | — | ≥ 32 random characters (`openssl rand -base64 48`). Keys the session-token digests stored in the DB |
| `STACK_MANAGER_ENCRYPTION_KEY_VERSION` | no | `1` | Recorded on every ciphertext; bump when rotating keys (re-encryption job is future work) |
| `STACK_MANAGER_PUBLIC_URL` | no | — | External origin behind a reverse proxy, e.g. `https://stacks.example.com`; used for CSRF origin checks |
| `STACK_MANAGER_COOKIE_SECURE` | no | `true` in production | Set `false` only for plain-HTTP local testing |
| `STACK_MANAGER_SETUP_TOKEN` | no | — | If set (≥ 16 chars), first-run admin setup requires it |
| `STACK_MANAGER_ALLOW_PRIVATE_NETWORKS` | no | `false` | Allow Git remotes on RFC 1918 / CGNAT / IPv6 ULA addresses (homelab Gitea/Forgejo). Loopback, link-local and metadata addresses are always blocked |
| `STACK_MANAGER_TRUSTED_PROXY_HOPS` | no | `0` | Trusted reverse proxies in front of the app. `0` ignores `X-Forwarded-For`/`X-Real-IP` (forgeable); with `N`, the client is the N-th `X-Forwarded-For` entry from the right. Only keys login/setup rate limits |
| `STACK_MANAGER_BIND` / `STACK_MANAGER_PORT` | no | `127.0.0.1` / `3000` | Host interface and port published by `docker-compose.yml` |
| `STACK_MANAGER_SESSION_TTL_HOURS` | no | `168` | Sliding session lifetime |
| `STACK_MANAGER_LOG_LEVEL` | no | `info` | `debug` \| `info` \| `warn` \| `error` |
| `STACK_MANAGER_WORKER_ENABLED` | no | `true` | Disable the in-process job worker (diagnostics only) |

The process **refuses to start** (exit code 1) when a required value is missing or malformed, e.g. an
encryption key that does not decode to 32 bytes. Error messages name the variable but never echo its value.

Keep the encryption key and session secret in your host's secret management, **separately from data backups**.
Losing the encryption key makes stored credentials unrecoverable (re-enter them); losing the session secret
only signs everyone out.

## Data directory

```text
$STACK_MANAGER_DATA_DIR/
  stack-manager.sqlite       # users, sessions (digests), workspaces, credential ciphertext, jobs, audit
  stack-manager.sqlite-wal   # SQLite write-ahead log (WAL mode)
  stack-manager.sqlite-shm
  repos/<connection-id>/     # local clones, one per repository connection
  git-home/                  # isolated HOME for git (no user config, no credential helpers)
```

Ownership and permissions:

- The container runs as `node` (uid/gid 1000). The image creates `/data` owned by `node` with mode `0700`;
  a fresh named volume inherits this.
- The application creates the directories above with mode `0700` and the database file with `0600`.
- When bind-mounting a host directory instead of a named volume, create it first and
  `chown 1000:1000` it (or run the container with a matching `--user`).
- Application files under `/app` are root-owned and read-only; `docker-compose.yml` also sets
  `read_only: true`, drops all capabilities and enables `no-new-privileges`. Only `/data` and `/tmp` are writable.

Nothing in the data directory belongs in Git. Clones never contain credentials: tokens are passed to `git` as a
per-process HTTP header and are not written to `.git/config`, remote URLs or logs.

## Startup, migrations and health

On start the server validates configuration, prepares the data directory, applies pending Drizzle migrations
(`drizzle/`), starts the job worker and then serves requests. `pnpm db:migrate` applies migrations without
starting the server.

`GET /api/health` returns `{"status":"ok"}` when the database is reachable; the image's `HEALTHCHECK` uses it.

## Reverse proxy and TLS

`docker-compose.yml` publishes the port on `127.0.0.1` only. Terminate TLS at a reverse proxy on the same host
and forward to it, or set `STACK_MANAGER_BIND` (e.g. `0.0.0.0`) if the proxy runs elsewhere. Behind a proxy that
appends to `X-Forwarded-For`, set `STACK_MANAGER_TRUSTED_PROXY_HOPS=1` so rate limits apply per client. Set `STACK_MANAGER_PUBLIC_URL` to the external origin
so the same-origin check on state-changing requests matches what browsers send. Session cookies are `Secure`,
`HttpOnly`, `SameSite=Lax` and use the `__Host-` prefix when `STACK_MANAGER_COOKIE_SECURE=true`.

## First run

Open the app and follow the setup: **admin account → workspace → repository**. If the instance is reachable by
others before you finish setup, set `STACK_MANAGER_SETUP_TOKEN` so only you can claim it. Setup can only happen
once; afterwards `/setup` redirects to sign-in.

## Upgrades

Back up the data volume, change `STACK_MANAGER_VERSION`, then `docker compose up -d`. Migrations run automatically. Back up the data volume first
(see [BACKUP_RESTORE.md](BACKUP_RESTORE.md)).

## Scaling notes

SQLite and the in-process worker assume **one instance** per data directory. Do not run replicas against the
same volume. Larger or multi-user installs should plan for the PostgreSQL adapter
(see [ARCHITECTURE.md](ARCHITECTURE.md#persistence-strategy)).
