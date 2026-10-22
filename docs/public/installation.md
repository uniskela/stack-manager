# Installation

stack-manager runs as a single container with its data in one volume. It needs no database server, no Redis and no
access to the Docker socket.

## Requirements

- Docker with the Compose plugin, on a linux/amd64 host
- A Git repository with your Compose files on GitHub, Gitea or Forgejo, reachable over HTTPS
- An access token for that repository (read access to browse and draft; write access to push commits)
- Ideally a reverse proxy that terminates TLS, such as Caddy, Traefik or Nginx Proxy Manager

## 1. Get the Compose file

Download [`docker-compose.yml`](../../docker-compose.yml) and [`.env.example`](../../.env.example) into an empty folder, or
clone the repository:

```sh
git clone https://github.com/uniskela/stack-manager.git
cd stack-manager
```

## 2. Configure

```sh
cp .env.example .env
```

Edit `.env` and set:

| Variable | Value |
| --- | --- |
| `STACK_MANAGER_VERSION` | The release to run, e.g. `0.1.0` ([releases](https://github.com/uniskela/stack-manager/releases)) |
| `STACK_MANAGER_ENCRYPTION_KEY` | Output of `openssl rand -base64 32` |
| `STACK_MANAGER_SESSION_SECRET` | Output of `openssl rand -base64 48` |

Store the encryption key somewhere safe **outside** your data backups: without it, saved tokens cannot be decrypted.

Optional settings you are likely to want:

- `STACK_MANAGER_PUBLIC_URL`: the address you open in the browser behind a reverse proxy, e.g.
  `https://stacks.example.com`
- `STACK_MANAGER_SETUP_TOKEN`: required during first-run setup, so nobody else can claim a fresh instance
- `STACK_MANAGER_ALLOW_PRIVATE_NETWORKS=true`: needed when your Gitea or Forgejo runs on your LAN (e.g. `192.168.x.x`)
- `STACK_MANAGER_COOKIE_SECURE=false`: only for testing over plain HTTP on localhost
- `STACK_MANAGER_AUTO_FETCH_ENABLED=true` and `STACK_MANAGER_AUTO_FETCH_INTERVAL_MINUTES=15`: automatically
  refresh connected Git repositories every 15 minutes by default while the worker is enabled; no deployment is triggered
  (individual repositories can override the interval or disable scheduled checks in their Overview)

After sign-in, set your Git author name and email under **Settings → Account**. Commits created by Stack Manager
use that identity; it does not grant repository permissions. See [Git workflow](GIT_WORKFLOW.md) for committing,
pushing and history.

Every variable is described in the [self-hosting reference](SELF_HOSTING.md#configuration).

Scheduled-fetch policy precedence is: `STACK_MANAGER_WORKER_ENABLED=false` stops background fetching;
`STACK_MANAGER_AUTO_FETCH_ENABLED=false` stops scheduled fetching; then a repository's disabled setting stops
its scheduled checks. Otherwise its interval override is used, or `STACK_MANAGER_AUTO_FETCH_INTERVAL_MINUTES`
(default 15, range 5–1440) when it inherits. Operator switches cannot be overridden by a repository.
Existing installations migrate to enabled repositories with a null interval override, preserving global defaults
and all synchronization history. Future server interval changes still reach inheriting repositories. Repository
settings apply on later scheduler ticks without restart; server environment changes require a restart.
Disabling scheduling does not cancel pending/running jobs or retries. Manual requests and post-push refreshes
still queue durable jobs; the worker must be enabled to process them. See [Keep it up to date](getting-started.md#7-keep-it-up-to-date).

## 3. Start

```sh
docker compose up -d
docker compose ps   # wait for "healthy"
```

The container listens on `127.0.0.1:3000` by default. Point your reverse proxy at it, or change `STACK_MANAGER_BIND`
if the proxy runs on another host. Then open the app and continue with [Getting started](getting-started.md).

## Image tags

Images are published to `ghcr.io/uniskela/stack-manager` for each release:

| Tag | Use |
| --- | --- |
| `0.1.0` (or `v0.1.0`) | Recommended: a fixed release that never changes |
| `0.1` | Latest patch of a minor release |
| `latest` | Newest release |

Each image is scanned for vulnerabilities and smoke-tested before it is published, and carries an SBOM and build
provenance.

## Upgrading

1. Back up the data volume (see [Backup and restore](BACKUP_RESTORE.md)).
2. Read the [release notes](https://github.com/uniskela/stack-manager/releases) for the versions in between.
3. Set the new `STACK_MANAGER_VERSION` in `.env` and run `docker compose up -d`.

Database migrations run automatically on start. Because the version is pinned in `.env`, nothing upgrades until you
change it. Upgrading from v0.5.x? Follow [Upgrading to v0.6.0](UPGRADING_0_6.md), including its acceptance
checklist before you enable automatic deployment.

## Building from source

To run your own checkout instead of a published image:

```sh
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

The locally built image is tagged `stack-manager:local`, so it can't be mistaken for a release.

## Optional Git push webhooks

Repository Overview → **Git webhooks** accepts signed GitHub, Gitea and Forgejo push deliveries.
Configure a separate encrypted signing secret and POST JSON webhook in the forge. Verified pushes
queue a source fetch and authorize routing only for stacks that explicitly enable automatic deployment.
Polling remains available; fetching alone does not authorize deployment or verify container health.
See [Git push webhooks](GIT_WEBHOOKS.md) for HTTPS, proxy, signature, rotation and recovery instructions.

## Optional deployment webhooks

Open an explicitly registered stack’s **Deployment** tab to save a Portainer or generic HTTPS webhook.
The complete URL and optional bearer token are encrypted and masked after saving. **Deploy now** requires
a deliberate confirmation and records queued, running, accepted, rejected or unknown outcomes. Acceptance
is not container health. Automatic deployment defaults to off. To opt in, configure a signed Git webhook,
fetch successfully, review the routing rules and select **Deploy automatically after verified Git pushes**.
Saving establishes the current fetched HEAD as a baseline; old history never deploys. Only corresponding
signed tracked-branch forge pushes authorize automatic requests; Fetch now, polling and in-app pushes alone
only fetch. Use **Preview routing** to check sample paths without saving or sending a request.
A later push during an active deployment is saved as blocked for manual action. An unknown outcome holds
automation: inspect the receiver, then deliberately use **Deploy now** to resume. Saving does not clear the hold.
Private homelab destinations require the existing operator network opt-in; TLS verification stays enabled.
See [Deployment webhooks](DEPLOYMENT_WEBHOOKS.md) for setup, request contracts, rotation, uncertainty,
network security, migrations, backups and rollback.

Before upgrading to routing migration `0010_large_salo` (after `0009`), stop the application and take a
consistent SQLite/WAL backup; retain encryption keys separately. Existing bindings remain opted out.
For rollback, stop workers, inspect receivers, restore the pre-upgrade backup with its keys and run the
matching prior pinned application version. Restoring SQLite cannot undo requests already sent. See the
[deployment migration and rollback guide](DEPLOYMENT_WEBHOOKS.md#migration-backups-and-rollback).
