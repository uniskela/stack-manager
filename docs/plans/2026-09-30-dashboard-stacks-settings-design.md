# Design: Dashboard, organised Stacks, Settings split

**Status:** implemented — see [2026-09-30-dashboard-stacks-settings-implementation.md](./2026-09-30-dashboard-stacks-settings-implementation.md)  
**Date:** 2026-09-30  
**Slice:** A of the phased UX/ops roadmap (scheduled fetch and Portainer deploy webhooks follow in later PRs)

## Goal

Give signed-in operators a clear home, a findable stacks inventory for large monorepos, and settings that match the UI plan — without becoming a container manager ([ADR 0005](../adr/0005-product-boundary.md)) and without pulling Git commit (#4) or deployment routing (#5) work forward.

## Non-goals (this PR)

- Cron / scheduled repository fetches
- Portainer or generic deploy webhooks
- “Fire webhook on commit” checkbox
- Command palette, favourites, tags, custom stack folders
- Runtime / Deployment Watch surfaces

## Architecture

Route-first information architecture inside the existing App Router workspace shell:

| Path | Page |
| --- | --- |
| `/w/{workspaceId}` | Dashboard (new home) |
| `/w/{workspaceId}/stacks` | Organised stacks list |
| `/w/{workspaceId}/repositories` | Repository list (moved from workspace root) |
| `/w/{workspaceId}/repositories/new` | Connect repository (unchanged) |
| `/w/{workspaceId}/repositories/{id}/…` | Repository detail (unchanged) |
| `/w/{workspaceId}/settings` | General |
| `/w/{workspaceId}/settings/credentials` | Credentials |
| `/w/{workspaceId}/settings/activity` | Activity |
| `/w/{workspaceId}/settings/account` | Account |

Sidebar order: **Dashboard → Stacks → Repositories → Settings**. Brand and post-login landing use the Dashboard. Empty-workspace CTAs still guide operators to connect a repository.

Reuse existing domain services (workspaces, repositories, stacks, source drafts, audit, auth). Add only small read helpers and Account APIs where missing. No new providers.

## Components

### Navigation

- Update `AppShell` nav items: Dashboard (`/w/{id}`), Stacks, Repositories (`/w/{id}/repositories`), Settings.
- Active-state matching updated so Dashboard does not light up on `/repositories` or `/stacks`.
- Move current workspace-home repository list into `/repositories/page.tsx`.

### Dashboard

Calm source overview (not an ops board):

1. `PageHeader` — workspace name; short “Source workspace overview” description.
2. Summary strip — counts: repositories, stacks, open drafts; sync status breakdown (`ready` / `syncing` / `error` / `pending`).
3. Needs attention — linked rows for:
   - repositories with `syncStatus === 'error'` (include last error summary when present)
   - stacks that have drafts
   - drafts marked outdated (upstream blob moved)
   - empty copy: “Nothing needs attention.”
4. Shortcuts — Stacks, Repositories, Settings; plus Connect repository when there are zero repos.
5. Recent activity — ~8 latest audit events with human labels and target links when resolvable; same redaction rules as today.

Data from existing list/count paths; add a workspace-scoped helper for outdated-draft aggregation if needed.

### Organised Stacks

Grouping (stable sort, shared helper):

1. By repository (name, then id)
2. Within a repo, by first segment of `rootPath` (`100-casaos/apprise` → `100-casaos`; empty root → `(repository root)`)
3. Within a group, by stack name

UI:

- Search filters stack name, repository name, and full `rootPath`
- Collapsible repository sections and folder subheaders; rows keep name, path, draft pill, chevron
- Collapse state in `sessionStorage` keyed by workspace (default: all expanded)
- Empty search: “No stacks match.” Zero stacks: keep current empty state

### Settings split

Settings layout with sub-nav: General · Credentials · Activity · Account.

| Tab | Behaviour |
| --- | --- |
| General | Workspace rename (existing form) |
| Credentials | Existing list/actions; empty-state CTA to connect a repository; show “Used by” repository names when attached |
| Activity | Human-readable action labels, outcome badges, target link when resolvable; ~25 rows; redaction unchanged; cursor pagination deferred if it expands the PR |
| Account | Change password (current + new + confirm); list sessions (created / last seen / current marker); revoke one session; sign out everywhere else |

Account requires new `/api/auth/…` routes behind `defineRoute`: change password, list sessions, revoke session(s). Password change uses Argon2id via `AuthService`, never returns hashes/tokens, and revokes other sessions after success while keeping the current session. Extend session repository/port with list-by-user and revoke helpers.

Sidebar Sign out remains; Account owns password and multi-session management.

## Data flow

```text
Browser → App Router pages (RSC where possible)
       → application services (repos, stacks, source, audit, auth)
       → SQLite ports

Account mutations → POST /api/auth/... → AuthService → Session/User repos → audit (redacted)
```

Stacks grouping and search may run in a client island over RSC-fetched data for interactivity; grouping helper lives in `src/shared` or a pure module under `src/ui` with unit tests.

## Error handling

- Dashboard/Stacks/Settings reads: existing not-found / empty patterns; sync errors surface as attention rows, not silent failures.
- Password change: field-level validation (mismatch, length); generic failure on wrong current password (no user enumeration beyond auth norms already used at login).
- Session revoke: 404 if missing/foreign; cannot revoke current session via “revoke one” without an explicit “sign out” path (or treat revoke-current as logout).
- APIs: `defineRoute` auth default-deny; coverage test remains green.

## Testing

- Unit: stack grouping helper; activity label mapping; auth password-change / session-list behaviour.
- Integration or route tests for new auth endpoints (happy path + wrong password + revoke).
- Playwright: nav order and Dashboard as home; stacks search/group smoke; settings tab navigation; account change-password smoke if feasible in e2e harness.
- `pnpm check` and relevant e2e must pass.

## Follow-ups (later PRs)

1. Scheduled / cron repository fetches  
2. PR #4 Git workflow  
3. PR #5 Deployment routing (Portainer/generic webhooks + optional fire-on-commit)

## Success criteria

- Logged-in landing is Dashboard; nav order is Dashboard → Stacks → Repositories → Settings.
- Large monorepo stacks are findable via repo + top-level folder grouping and search.
- Settings are split into four routes including Account password/sessions.
- Product boundary intact: no Containers/Images/Networks/Volumes pages; no deploy/runtime features in this PR.
