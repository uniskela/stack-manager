# Product definition

## One-line summary

**stack-manager** is a Git-native source workspace for self-hosted Compose infrastructure, with deployment awareness.

## Product identity

Treat this application as:

> A Git-native source workspace for self-hosted Compose infrastructure, with deployment awareness.

Do **not** treat it as:

> A Portainer alternative.

### Product boundary (hard)

stack-manager manages the Git-backed **source/configuration** describing stacks. It is **not** a container-management replacement for Portainer, Komodo, Arcane, Docker Desktop, or Docker itself.

Portainer and other runtime systems remain **downstream** deployment and/or runtime providers.

Runtime information is **optional**, **read-only**, and **contextual** around source edits and deployments. Runtime must never become the authoritative configuration source. Git remains authoritative. Never silently rewrite source to match runtime.

If a proposed feature starts to resemble *“use this instead of Portainer to manage your Docker host”*, stop and reconsider against this document.

## Conceptual hierarchy

```text
Git repository
→ Stack source files
→ Compose configuration
→ documentation
→ environment references
→ secret references
→ validation
→ Git commit
→ deployment trigger
→ optional runtime observation
```

## Core UI focus

The primary UI revolves around editing text/configuration:

- `compose.yml` / `compose.yaml` / `docker-compose.yml` / `docker-compose.yaml`
- Markdown documentation
- `.env.example` and other non-secret configuration
- Supporting YAML / JSON / TOML where appropriate

Do **not** build major Docker-management pages for Containers, Images, Networks, or Volumes. Provide “Open in Portainer” (or equivalent provider deep-links) where possible.

## User-facing summary

> I edit and manage my Docker Compose Git repo through this app. It understands my stacks, docs, environment variables and secrets. When I commit something, it deploys only the stack I changed through Portainer/another deployment system, then watches the runtime to tell me whether my change worked.

## Valid configurations (examples)

All of the following must be representable without changing the core stack model:

1. **GitHub + no secret provider + generic deploy webhook** (no runtime provider)
2. **Gitea + Infisical + Portainer webhook + Portainer Runtime**
3. **Forgejo + Vault + Komodo deploy + Komodo Runtime** (future providers; model must allow)

Users must be able to use the application with **no runtime integration at all**.

## Goals

1. Make Compose stack source editing safe, understandable, and mobile-friendly.
2. Keep the Git repository authoritative for configuration.
3. Map repository paths to explicit stack scopes (never infer solely from folder names).
4. Route Git push events to **only** affected stacks via deployment relevance rules.
5. Trigger deployments through pluggable **DeploymentProviders** (webhooks first).
6. Optionally observe runtime via pluggable **RuntimeProviders** (read-only).
7. Provide Deployment Watch and failure correlation (Git ↔ diff ↔ deploy ↔ runtime ↔ logs).
8. Store provider credentials encrypted at rest; never leak them to clients, logs, Git, or audit payloads.

## Non-goals

| Non-goal | Rationale |
| --- | --- |
| Replace Portainer/Komodo/Arcane | Those own container lifecycle |
| Destructive Docker controls | delete container/volume/network, prune, exec, arbitrary restart |
| Authoritative runtime config sync into Git | Git is source of truth |
| Multi-tenant SaaS / serverless-first design | Self-hosted long-running Node in Docker |
| Built-in secret vault competing with Infisical/Vault | Integrate as SecretProvider |
| Host-level Docker socket management | Out of product boundary |
| Infer stack↔runtime bindings from folder names alone | Explicit bindings only |

## Stack header (runtime is secondary)

Example contextual runtime strip (never the primary editing chrome):

```text
LiftLog
● Healthy
1 container
Running image: ghcr.io/example/liftlog:1.9.2
Last runtime refresh: 12 sec ago
```

Suggested tabs:

`Compose | Files | Docs | Environment | Secrets | Changes | Deployments`

## Example stack binding (explicit)

```text
Stack: LiftLog

Source:
  repository: portainer-stacks
  root: 122-personal-apps/liftlog
  compose: docker-compose.yml

Deployment:
  provider: portainer-webhook
  target: LiftLog webhook

Runtime:
  provider: portainer-api
  environment: CT122
  stack mapping: LiftLog

Secrets:
  provider: infisical
  project: portainer-stacks
  environment: prod
  path: /122-liftlog
```

None of these relationships are inferred solely from folder names.

## Success criteria (product)

- A user can connect a Compose monorepo, define stack scopes, edit compose/docs, commit/push, and trigger only affected deployments.
- Runtime can be omitted entirely without breaking core workflows.
- No Containers/Images/Networks/Volumes management surfaces ship as core navigation.
- Credentials never appear in client responses after save, logs, Git, or unredacted audit events.
