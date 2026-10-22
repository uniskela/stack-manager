# AGENTS.md

Guidance for coding agents working on **stack-manager**.

## Product boundary

Read [docs/public/PRODUCT.md](docs/public/PRODUCT.md) and [docs/internal/adr/0005-product-boundary.md](docs/internal/adr/0005-product-boundary.md) before adding features.

This app manages Git-backed **source/configuration** for Compose stacks. It is **not** a Portainer/Komodo/Arcane replacement. No Containers/Images/Networks/Volumes management pages. Runtime is optional and read-only.

## Current phase

**PR #5 — Deployment routing** (DeploymentProvider, Portainer/generic webhooks, forge webhook receiver, relevance
rules, selective deploy) is implemented on `main` for v0.6.0 and is in its release gate (#57; release PR #41).
PR #2 (application foundation), PR #3 (source workspace) and PR #4 (Git workflow: commit, safe push, conflict
protection, stack history, Changes UI; released in v0.5.0) are done. The maintainer picks the next phase from the
roadmap. Do not build secrets providers, runtime watch or PWA work ahead of their phases.

See [docs/public/plans/MVP_PLAN.md](docs/public/plans/MVP_PLAN.md) and the code layout in
[docs/public/ARCHITECTURE.md](docs/public/ARCHITECTURE.md#code-layout-implemented-in-pr-2-extended-through-v050).

## Working in the code

- `pnpm check` must pass (format, lint, typecheck, tests). `pnpm build` must succeed.
- PR titles (and so squash-merge commits) must be Conventional Commits (`feat:`, `fix:`, `docs:`, …); Release
  Please derives versions and the changelog from them. See [docs/public/RELEASING.md](docs/public/RELEASING.md).
- Schema changes: edit `src/server/persistence/schema.ts`, run `pnpm db:generate`, commit the migration.
- API routes: always wrap handlers with `defineRoute` (auth is default-deny; a coverage test enforces this).
- Services receive dependencies through `src/server/container.ts`; depend on ports, not Drizzle.
- Never return credential ciphertext/plaintext from APIs; decrypt only via `CredentialService.withPlaintext`.
- Pass anything user- or provider-derived through the redacting logger/audit APIs; job payloads carry ids only.
- Run `git` only through `GitCli` (argv arrays, hardened env, protocol allowlist).
- Read repository content through `SourceTreeReader` (Git objects, never the working tree). Never return the
  contents of secret-looking files (`isSecretPath` in `src/shared/source/paths.ts`) or accept drafts for them.
- `src/shared` is pure code shared by server and browser (no Node, React or server imports; lint-enforced).
- User docs are published to uniskela.com from `docs/manifest.json` (see `.github/docs-sync.md`). Write them under
  `docs/public/` (setup, deployment, backups, security and other user-facing references). Implementation plans and
  architecture decisions go under `docs/internal/`. Agent-only notes go under `docs/agents/`; this file stays the
  canonical agent guide. When a feature changes what users see, update `docs/public/getting-started.md` /
  `docs/public/installation.md` and list new pages in the manifest. Do not change published slugs.
- UI tests: `pnpm build && pnpm test:e2e` (set `E2E_GIT_REMOTE`/`E2E_STACK_ROOT` to a public repo and stack folder to include the editor tests).

## Tech direction (locked)

- Next.js + TypeScript + Drizzle + SQLite (Postgres-ready ports)
- Modular monolith, long-running Docker Node (not serverless)
- Persisted DB jobs (no Redis unless justified)
- CodeMirror 6 preferred for editors
- Capability providers: Git / Deployment / Runtime / Secret

## Prior art

`uniskela/stackwise` is an unrelated inventory SPA. Do not import its code. See [docs/internal/PRIOR_ART.md](docs/internal/PRIOR_ART.md).

## Security

Never log or commit credentials. Encrypt provider secrets at rest. Redact audit events. See [docs/public/SECURITY.md](docs/public/SECURITY.md).

## Docs map

[docs/internal/INDEX.md](docs/internal/INDEX.md)

<!-- adhd-hub:project-agent:start -->
<!-- adhd-hub:guidance-version:8 -->
## ADHD Hub continuity

For substantial work in this project:

- If ADHD Hub MCP tools are missing, errored, unauthorized, or otherwise
  unavailable: on the first substantial Hub-worthy turn after detecting the
  outage, the **first line** MUST state that Hub MCP is not available, plus a
  short fix hint (MCP URL → this Hub's `/mcp`, `ADHD_HUB_AUTH_TOKEN`, restart
  the agent; skip/cancel Auth if it hangs until Hub OAuth is enabled). Repeat
  only if Hub status changes, a persistence attempt fails again, or the reply
  could otherwise imply continuity was saved. Then continue the authorized
  work. Never invent Hub state or claim a Hub write succeeded.
- **MCP unavailable** is the Hub continuity trigger (not runtime alone). Use
  the `env-check` skill — resolve `scripts/check_runtime.sh` from the installed
  skill (project-scoped: `.agents/skills/env-check/…`; Hub source:
  `skills/env-check/…`) — for CLOUD_AGENT vs LOCAL_WORKSPACE as supporting
  context (`CURSOR_AGENT`, container cues — never `$USER=root` alone). When Hub
  MCP is unreachable, use the forge issue mailbox only when issue-write access
  is available and the authenticated identity is accepted by Hub Inbox authors.
  Open/update a GitHub/Gitea issue titled `[ADHD] …` with a short
  Goal/Focus/Next/Resume cue. Optional labels: `adhd-hub`, `project:<slug>`,
  `source:cursor`; skip labels if the token cannot set them. Recommended:
  append `Made with [ADHD Progress Hub](https://github.com/uniskela/adhd-hub)`
  under a non-imported heading (e.g. `## Attribution`) so it does not land in
  Resume. Prefer short repository-relative summaries; never invent Hub
  continuity, progress, or thread state after a forge-only write. Never put
  credentials, tokens, personal/customer data, private hostnames/IPs, absolute
  local paths, transcripts, or secrets/env contents in forge issues.
- CLOUD_AGENT: do not assume machine-installed local skill CLIs (e.g.
  `graphify`) exist. If missing: one-line notice, continue via repo tools /
  committed `graphify-out/` when present; never fabricate graph or Hub state.
  Prefer headless tests and injected env/OIDC over `.env.local`; no native
  browser/macOS-Windows binaries. Hub MCP down still uses the `[ADHD]` forge
  mailbox when allowed. LOCAL_WORKSPACE: those local CLIs may be available;
  local docker / localhost OK; prefer Hub MCP when up.
- Skip Hub for trivial/read-only/tiny work.
- Once per meaningful session: `resolve_project` with
  `create_if_missing=false`, then `session_digest` with the task query. Reuse
  resolved context where possible. Create/register only after the workspace is
  authorized as a Hub project.
- **One thread = one independently finishable outcome** (not the whole repo).
  Size the Goal to what the agent can finish (e.g. open a review-ready PR).
  A Goal that includes merge/deploy stays open/paused until that is done — do
  not auto-split every PR into a second thread. Before updating a thread,
  compare new work to that thread's Goal; if it does not advance the same
  outcome, use another thread or create one.
- Known thread → `upsert_progress(thread_id=...)` with compact structured state
  (goal / focus / ≤3 next / blocked if any / resume); omit ritual `content`.
  Do not silently attach to an unrelated open thread.
- `check_overlap` only before potentially new work; reuse only when the Goal
  matches. Different goal → separate thread (`force_new_thread` if needed).
- End-of-task (checkpoint first if Hub state is stale): `completion.ready`
  reflects stored state only (not PR/CI/merge), so it can block `mark_done`
  but never approve it alone. `mark_done` on that thread only when `ready` is
  `true` or absent **and** the Goal is done with nothing remaining (optional
  final checkpoint first). `ready == false` (even if the Goal looks done) or
  any remaining work (review, draft PR, CI, merge, deploy, verify, or a next
  action — even if `ready == true`) → `upsert_progress` (record it in
  `next_steps`) then `pause_thread(thread_id, next_step=...)` — do **not**
  `mark_done`. If `mark_done` is denied/rejected for unfinished work:
  do not retry; checkpoint + `pause_thread` and continue the normal response.
- If Hub guidance looks stale (session_digest guidance status, or doctor),
  mention it once, keep using the current MCP contract, and recommend
  `adhd-hub setup . --refresh` and `adhd-hub sync-project .` (or
  `setup . --project-skills`) — do not nag repeatedly or hand-edit AGENTS.md.
- Summaries only; never secrets, credentials, env files, transcripts, private
  Hub URLs, internal hosts/IPs, or absolute machine paths in public artifacts.
<!-- adhd-hub:project-agent:end -->
