# stack-manager

A Git-native workspace for the Docker Compose repository behind your self-hosted services.

[Install](installation.md) · [Getting started](getting-started.md) ·
[View on GitHub](https://github.com/uniskela/stack-manager)

**Self-hosted · single container · SQLite · GitHub / Gitea / Forgejo · no Docker socket**

## What it does

Most homelab and small-team setups keep their Compose files in Git and deploy them with Portainer, Komodo or a
similar tool. stack-manager is the place where you **edit and review that source**:

- **Stacks:** connect a repository and pick the folders that hold Compose stacks. A repository can hold many stacks.
- **Editor:** a VS Code-style editor with a file explorer, tabs, Compose validation and a problems panel. It works on
  phones too.
- **Drafts:** edits are saved as drafts on the server, so nothing touches your repository until you review it.
- **Docs:** read each stack's Markdown documentation next to its configuration.
- **Environment:** see which variables a stack uses, whether `.env.example` documents them, which env files it
  expects and which values look like hard-coded secrets. Values are never shown.
- **Changes:** review every draft as a diff against the fetched commit before it goes anywhere.

Secret files such as `.env`, keys and certificates are never displayed or editable, and provider tokens are stored
encrypted.

## What it is not

stack-manager is **not** a Portainer, Komodo, Arcane or Docker UI replacement. It has no container, image, network or
volume pages and never needs the Docker socket. Your deployment tool stays in charge of running containers;
stack-manager looks after the Git source they are deployed from.

## Status

stack-manager is in early development (0.x). Available today: sign-in, workspaces, encrypted credentials, repository
connections, stacks, dashboard and settings, the editor with drafts, docs, the environment inventory and change review.

Stack-scoped Git history is available on each stack's History tab. Coming in v0.5.0: committing drafts and safe push.
After that on the [roadmap](plans/MVP_PLAN.md):
deploying only the stacks a commit changed (through Portainer and others), then optional read-only runtime feedback.

## Documentation

**Start here**

- [Installation](installation.md): run the container with Docker Compose
- [Getting started](getting-started.md): first run, connecting a repository, adding stacks and editing

**Deploy and operate**

- [Self-hosting reference](SELF_HOSTING.md): configuration, data directory, reverse proxy, upgrades
- [Backup and restore](BACKUP_RESTORE.md)
- [Authentication and credentials](AUTH_AND_CREDENTIALS.md)
- [Security](SECURITY.md)

**Project**

- [Product scope](PRODUCT.md) and [stack discovery](STACK_DISCOVERY.md)
- [Architecture](ARCHITECTURE.md)
- [Releases and CI](RELEASING.md) and [testing](TESTING.md)
- [Roadmap](plans/MVP_PLAN.md)
