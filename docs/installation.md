# Installation

stack-manager runs as a single container with its data in one volume. It needs no database server, no Redis and no
access to the Docker socket.

## Requirements

- Docker with the Compose plugin, on a linux/amd64 host
- A Git repository with your Compose files on GitHub, Gitea or Forgejo, reachable over HTTPS
- An access token for that repository (read access is enough for now)
- Ideally a reverse proxy that terminates TLS, such as Caddy, Traefik or Nginx Proxy Manager

## 1. Get the Compose file

Download [`docker-compose.yml`](../docker-compose.yml) and [`.env.example`](../.env.example) into an empty folder, or
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

Every variable is described in the [self-hosting reference](SELF_HOSTING.md#configuration).

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
change it.

## Building from source

To run your own checkout instead of a published image:

```sh
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

The locally built image is tagged `stack-manager:local`, so it can't be mistaken for a release.
