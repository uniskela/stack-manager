# Phased MVP implementation plan

PR #1 (documentation) and PR #2 (application foundation) are merged. **PR #3 (source workspace) is the active phase.** Subsequent PRs implement the product. Boundaries may shift for strong technical reasons; avoid giant cross-cutting PRs.

## PR sequence

| PR | Title | Outcome |
| --- | --- | --- |
| **#1** | Product architecture & plan | This docs tree; no app scaffold |
| **#2** | Application foundation | Scaffold, auth, DB, encrypted credentials, workspace/repo model, Git connection |
| **#3** | Source workspace | Stack discovery/scopes, Compose/docs editors, file browser, validation, env-ref parsing, mobile editor UX |
| **#4** | Git workflow | Draft/working tree, diff, commit, push, conflict protection, stack-scoped history, optional branch/PR |
| **#5** | Deployment routing | DeploymentProvider + Portainer/generic webhooks, forge webhook receiver, relevance rules, selective deploy, idempotency, audit |
| **#6** | Environment / secrets | Env inventory, `.env.example`, SecretProvider + Infisical, metadata without exposing values by default |
| **#7** | Runtime observation | RuntimeProvider + Portainer read-only, header status, drift warnings, Deployment Watch, failure context, deep-links |
| **#8** | PWA / polish / hardening | Installable PWA, offline-safe drafts, a11y, performance, security hardening, backup/restore validation, provider docs |

## PR #1 exit criteria

- [x] Product definition and non-goals documented
- [x] Prior art (incl. stackwise) documented; no code import
- [x] Domain model and provider abstractions documented
- [x] Routing, Git workflow, Deployment Watch documented
- [x] Auth/credentials, threat model, UX, backup, testing documented
- [x] ADRs for tech stack, jobs, editor, monolith, product boundary
- [x] Phased plan (#2–#8) recorded
- [x] PR opened to `uniskela/stack-manager` and CodeRabbit reviewed

## PR #2 exit criteria

- [x] Next.js App Router + TypeScript modular monolith; standalone long-running Node server
- [x] Drizzle schema + migrations for User, Session, Workspace, GitRepositoryConnection, ProviderCredential, Job, AuditEvent
- [x] First-run admin setup, Argon2id, HTTP-only sessions, origin checks, logout, route protection
- [x] AES-256-GCM provider credentials with key version; masked API contract; replace-only secrets; fail closed
- [x] Workspace + repository connection setup flow (GitHub / Gitea / Forgejo over HTTPS)
- [x] Access test, clone/fetch under the data dir, branch metadata, hardened git invocation
- [x] Persisted jobs with leases, heartbeats, reclaim, retries and dead-lettering
- [x] Redaction-by-default logging and audit
- [x] Dockerfile, docker-compose.yml, `.env.example`, healthcheck, non-root, migrations on start
- [x] CI: format, lint, typecheck, tests, migration drift, build, smoke, Docker image
- Deferred: SSH remotes, webhook credential/verification (PR #5), commit/push (PR #4), key re-encryption job

## PR #3 exit criteria

- [x] Explicit `Stack` records (root folder + primary Compose file); discovery suggests folders with a Compose file, operator confirms
- [x] Read-only access to committed files from Git objects (`ls-tree` / `cat-file`), scoped to the stack folder
- [x] Secret-looking files (`.env`, keys, `secrets/`) listed as locked; contents never returned; drafts refused
- [x] VS Code-style editor on CodeMirror 6: explorer, tabs, problems panel, status bar, Ctrl/⌘+S, soft-wrap on mobile
- [x] Drafts persisted in the database (`source_drafts`), outdated detection when the file changes upstream
- [x] Live validation: YAML syntax, Compose structure, unknown services/networks/volumes, hard-coded secrets, unpinned images
- [x] Environment inventory: `${VAR}` references, defaults/required, `.env.example` coverage, env_file references
- [x] Docs tab: Markdown reading view (Notion-style) with Edit and Split live-preview modes
- [x] Changes tab: unified diff of drafts against their base, discard
- [x] Unit, integration and Playwright + axe tests (desktop/mobile, light/dark)
- Deferred to PR #4: commit/push of drafts, conflict resolution, stack-scoped history. Deferred: `docker compose config` validation (needs a Docker binary), docs globs per stack, command palette

## Dependency graph

```text
PR2 foundation
  └─ PR3 source workspace
       └─ PR4 git workflow
            ├─ PR5 deployment routing
            │    └─ PR7 runtime / Deployment Watch (needs deploy events + runtime)
            └─ PR6 env/secrets (can partially parallel PR5 after PR3)
PR8 polish (after #5–#7 vertical slices are usable)
```

### Allowed parallelisation

- After **PR #3**: PR #6 (secrets/env) can proceed in parallel with **PR #4/#5** if interfaces are stable.
- **PR #7** should follow **PR #5** so watch attaches to real deploy triggers; stub watch in #5 is acceptable only as no-op hooks.
- **PR #8** must not open until core paths from #4–#7 exist.

## Reorder guidance

Do **not** move runtime (#7) before deployment routing (#5): watch without deploy events invites building a container dashboard.

Do **not** expand #5 into Portainer management UI. Webhook deploy + audit only.

If Git forge PR/branch flow proves large, keep optional PR/branch work behind a flag inside #4 rather than splitting a #4b unless necessary.

## Tech commitments carried into #2+

See ADRs:

- Next.js + TypeScript + Drizzle + SQLite (Postgres-ready ports)
- Modular monolith, Docker long-running Node
- Persisted jobs table (no Redis unless later justified)
- CodeMirror 6 preferred for editors
- Capability-based providers; Portainer not a core dependency

## Definition of done (product MVP after #8)

A user can:

1. Connect a Git Compose monorepo
2. Define stack scopes and bindings explicitly
3. Edit compose/docs on desktop and mobile
4. Commit/push with validation and conflict protection
5. Receive forge webhooks and deploy only affected stacks
6. Optionally observe Portainer runtime and Deployment Watch results
7. Correlate failures across Git, diff, deploy, runtime, logs
8. Backup/restore application data safely
9. Never see Containers/Images/Networks/Volumes as first-class management pages
