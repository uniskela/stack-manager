# Dashboard, organised Stacks, Settings split — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship design slice A — Dashboard as workspace home, findable organised stacks, and settings split (General / Credentials / Activity / Account) without container-manager or Git/deploy features.

**Architecture:** Route-first App Router IA inside the existing `AppShell`. Move the repository list to `/repositories`, put a calm source Dashboard at `/w/{id}`, enhance `/stacks` with pure grouping + client search, split settings into nested routes, and add AuthService session/password APIs for Account. Reuse workspaces, repositories, stacks, source drafts, and audit services.

**Tech Stack:** Next.js App Router, TypeScript, Drizzle/SQLite, Vitest, Playwright, existing UI primitives (`PageHeader`, `EmptyState`, `Section`, `StatusPill`, `ButtonLink`).

**Design spec:** [2026-09-30-dashboard-stacks-settings-design.md](./2026-09-30-dashboard-stacks-settings-design.md)

## Global Constraints

- Product boundary ([ADR 0005](../adr/0005-product-boundary.md)): no Containers / Images / Networks / Volumes pages; no deploy/runtime features.
- Do not pull PR #4 Git commit workflow or PR #5 deployment routing forward.
- API routes always use `defineRoute` (auth default-deny); coverage test must stay green.
- Never return password hashes, session token plaintext, or credential secrets from APIs.
- Run `git` only via `GitCli`; read trees via `SourceTreeReader`.
- `src/shared` stays pure (no Node/React/server imports).
- Commits: only when the operator explicitly asks (user rule overrides frequent-commit plan defaults). Stage logical checkpoints; do not auto-commit.
- After code changes: `pnpm check` must pass before considering a task done. Update user docs / `docs/manifest.json` when user-visible IA changes.
- Graphify: before broad exploration, `graphify query`; after code edits, `graphify update .`.

---

## File map

| Path | Responsibility |
| --- | --- |
| `src/ui/shell/app-shell.tsx` | Nav order: Dashboard → Stacks → Repositories → Settings; active matching |
| `src/app/w/[workspaceId]/page.tsx` | Dashboard (replaces repo list) |
| `src/app/w/[workspaceId]/repositories/page.tsx` | **Create** — current home repo list |
| `src/app/w/[workspaceId]/stacks/page.tsx` + `src/ui/stacks/*` | Organised list + search island |
| `src/shared/stacks/group-stacks.ts` | Pure grouping + filter helpers + types |
| `src/app/w/[workspaceId]/settings/layout.tsx` | Settings sub-nav |
| `src/app/w/[workspaceId]/settings/page.tsx` | General only |
| `src/app/w/[workspaceId]/settings/credentials/page.tsx` | Credentials |
| `src/app/w/[workspaceId]/settings/activity/page.tsx` | Activity |
| `src/app/w/[workspaceId]/settings/account/page.tsx` + `src/ui/account/*` | Account UI |
| `src/shared/audit/labels.ts` | Human labels for audit actions |
| `src/server/application/ports.ts` | Session/User port extensions |
| `src/server/persistence/sqlite/repositories.ts` | Port implementations |
| `src/server/application/auth-service.ts` | `changePassword`, `listSessions`, `revokeSession`, `revokeOtherSessions` |
| `src/app/api/auth/password/route.ts` | POST change password |
| `src/app/api/auth/sessions/route.ts` | GET list; DELETE revoke-others |
| `src/app/api/auth/sessions/[sessionId]/route.ts` | DELETE one session |
| `src/server/application/source-service.ts` | Workspace outdated-draft / draft-summary helper for Dashboard |
| Breadcrumb / CTA link sites | Point Repositories anchors at `/repositories` |
| `tests/unit/group-stacks.test.ts`, `tests/unit/audit-labels.test.ts` | Pure helpers |
| `tests/integration/auth.test.ts` | Password + sessions |
| `tests/e2e/shell.spec.ts` | Nav / home / settings tabs |

---

### Task 1: Stack grouping helper (pure)

**Files:**
- Create: `src/shared/stacks/group-stacks.ts`
- Test: `tests/unit/group-stacks.test.ts`

**Interfaces:**
- Consumes: stack-like `{ id, name, rootPath, repository: { id, name } }` plus optional `draftCount`
- Produces: `folderSegment(rootPath)`, `filterStacks`, `groupStacks` (repo → folder → stacks)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { filterStacks, folderSegment, groupStacks } from '@/shared/stacks/group-stacks';

const stacks = [
  {
    id: '1',
    name: 'apprise',
    rootPath: '100-casaos/apprise',
    draftCount: 0,
    repository: { id: 'r1', name: 'infra' },
  },
  {
    id: '2',
    name: 'rooty',
    rootPath: '',
    draftCount: 1,
    repository: { id: 'r1', name: 'infra' },
  },
  {
    id: '3',
    name: 'alpha',
    rootPath: '200-apps/alpha',
    draftCount: 0,
    repository: { id: 'r2', name: 'apps' },
  },
];

describe('folderSegment', () => {
  it('uses first path segment or repository-root label', () => {
    expect(folderSegment('100-casaos/apprise')).toBe('100-casaos');
    expect(folderSegment('')).toBe('(repository root)');
    expect(folderSegment('single')).toBe('single');
  });
});

describe('groupStacks', () => {
  it('groups by repository name then folder, sorted stably', () => {
    const groups = groupStacks(stacks);
    expect(groups.map((g) => g.repositoryName)).toEqual(['apps', 'infra']);
    const infra = groups.find((g) => g.repositoryId === 'r1')!;
    expect(infra.folders.map((f) => f.segment)).toEqual(['(repository root)', '100-casaos']);
    expect(infra.folders[1]!.stacks.map((s) => s.name)).toEqual(['apprise']);
  });
});

describe('filterStacks', () => {
  it('matches name, repository name, and full rootPath', () => {
    expect(filterStacks(stacks, 'casaos').map((s) => s.id)).toEqual(['1']);
    expect(filterStacks(stacks, 'INFRA').map((s) => s.id).sort()).toEqual(['1', '2']);
    expect(filterStacks(stacks, 'nope')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/unit/group-stacks.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement helper**

```ts
// src/shared/stacks/group-stacks.ts
export type GroupableStack = {
  id: string;
  name: string;
  rootPath: string;
  draftCount?: number;
  repository: { id: string; name: string };
};

export type StackFolderGroup<T extends GroupableStack = GroupableStack> = {
  segment: string;
  stacks: T[];
};

export type StackRepoGroup<T extends GroupableStack = GroupableStack> = {
  repositoryId: string;
  repositoryName: string;
  folders: StackFolderGroup<T>[];
};

export function folderSegment(rootPath: string): string {
  const trimmed = rootPath.replace(/^\/+|\/+$/g, '');
  if (!trimmed) return '(repository root)';
  return trimmed.split('/')[0] ?? '(repository root)';
}

export function filterStacks<T extends GroupableStack>(stacks: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return stacks;
  return stacks.filter(
    (s) =>
      s.name.toLowerCase().includes(q) ||
      s.repository.name.toLowerCase().includes(q) ||
      s.rootPath.toLowerCase().includes(q),
  );
}

export function groupStacks<T extends GroupableStack>(stacks: T[]): StackRepoGroup<T>[] {
  const byRepo = new Map<string, { name: string; stacks: T[] }>();
  for (const s of stacks) {
    const cur = byRepo.get(s.repository.id) ?? { name: s.repository.name, stacks: [] };
    cur.stacks.push(s);
    byRepo.set(s.repository.id, cur);
  }
  const repos = [...byRepo.entries()].sort((a, b) => {
    const byName = a[1].name.localeCompare(b[1].name);
    return byName !== 0 ? byName : a[0].localeCompare(b[0]);
  });
  return repos.map(([repositoryId, { name: repositoryName, stacks: repoStacks }]) => {
    const byFolder = new Map<string, T[]>();
    for (const s of repoStacks) {
      const seg = folderSegment(s.rootPath);
      const list = byFolder.get(seg) ?? [];
      list.push(s);
      byFolder.set(seg, list);
    }
    const folders = [...byFolder.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([segment, folderStacks]) => ({
        segment,
        stacks: [...folderStacks].sort((x, y) => x.name.localeCompare(y.name)),
      }));
    return { repositoryId, repositoryName, folders };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/unit/group-stacks.test.ts`
Expected: PASS

---

### Task 2: Navigation + move repository list

**Files:**
- Modify: `src/ui/shell/app-shell.tsx` (nav items ~86–99)
- Create: `src/app/w/[workspaceId]/repositories/page.tsx` (move content from current home)
- Modify: `src/app/w/[workspaceId]/page.tsx` — temporary redirect or leave for Task 4; **in this task**, move list to `/repositories` and make home a minimal placeholder **or** jump straight to Dashboard in Task 4. Prefer: move list now; home becomes Dashboard in Task 4 (home can briefly re-export empty redirect — better: after move, home shows a one-line “loading” only if Task 4 is same PR — **do both nav + move in this task; Dashboard content in Task 4**, home temporarily shows EmptyState “Overview coming” is wasteful — **implement Dashboard empty shell in Task 4 immediately after**. For this task: move repo list + update nav; set home to a stub PageHeader “Dashboard” with link to connect if zero repos so e2e doesn’t break mid-PR. Task 4 fills the rest.
- Modify link targets:
  - `src/app/w/[workspaceId]/repositories/[repositoryId]/layout.tsx` breadcrumb → `/repositories`
  - `src/app/w/[workspaceId]/repositories/new/page.tsx` breadcrumb + Skip → `/repositories`
  - `src/app/w/[workspaceId]/stacks/page.tsx` empty CTA → `/repositories`
  - `src/app/w/[workspaceId]/not-found.tsx` → “Back to dashboard” href `/w/{id}`
  - `src/ui/repository-actions.tsx` after delete → `/w/{workspaceId}` (dashboard) is fine per design
- Modify: `tests/e2e/shell.spec.ts` expectations for nav labels / home heading / back link

**Interfaces:**
- Consumes: existing repository list page markup
- Produces: sidebar order Dashboard → Stacks → Repositories → Settings; `/repositories` list page

- [ ] **Step 1: Update AppShell nav**

```ts
import { FolderGit2, LayoutDashboard, Layers, LogOut, Menu, Settings, X } from 'lucide-react';
// ...
const items = [
  {
    href: base,
    label: 'Dashboard',
    Icon: LayoutDashboard,
    active: pathname === base,
  },
  { href: `${base}/stacks`, label: 'Stacks', Icon: Layers, active: pathname.startsWith(`${base}/stacks`) },
  {
    href: `${base}/repositories`,
    label: 'Repositories',
    Icon: FolderGit2,
    active: pathname.startsWith(`${base}/repositories`),
  },
  {
    href: `${base}/settings`,
    label: 'Settings',
    Icon: Settings,
    active: pathname.startsWith(`${base}/settings`),
  },
];
```

- [ ] **Step 2: Create `repositories/page.tsx`**

Copy the current `WorkspaceHome` body from `src/app/w/[workspaceId]/page.tsx` (repo list + empty state). Keep `metadata.title = 'Repositories'`. Update any self-links if needed (list already links to `/repositories/{id}`).

- [ ] **Step 3: Stub Dashboard home**

Replace `page.tsx` with a minimal Dashboard shell:

```tsx
export const metadata: Metadata = { title: 'Dashboard' };

export default async function DashboardPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const workspace = await getContainer().workspaces.get(workspaceId);
  // Task 4 expands this; keep empty-workspace CTA:
  const repositories = await getContainer().repositories.list(workspaceId);
  if (repositories.length === 0) {
    return (
      <EmptyState /* same connect CTA as before, title can stay connect-focused */ ... />
    );
  }
  return (
    <PageHeader title={workspace.name} description="Source workspace overview" />
  );
}
```

(Full dashboard widgets land in Task 4.)

- [ ] **Step 4: Fix breadcrumbs / CTAs** listed in Files to use `/repositories` where they mean the inventory.

- [ ] **Step 5: Update e2e shell**

- Home heading: allow `Dashboard` / workspace name / connect empty state; nav `Dashboard` has `aria-current` on `/`; `Repositories` is a separate link.
- “Back to repositories” → “Back to dashboard” or match not-found copy.
- Connect-repo breadcrumb still says Repositories but href is `/repositories`.

- [ ] **Step 6: Verify**

Run: `pnpm check` (at least typecheck/lint for touched files). Spot-check: `pnpm exec vitest run` if quick.

---

### Task 3: Organised Stacks UI

**Files:**
- Modify: `src/app/w/[workspaceId]/stacks/page.tsx`
- Create: `src/ui/stacks/organised-stacks.tsx` (client island: search + collapse)
- Consumes: `groupStacks` / `filterStacks` from Task 1

**Interfaces:**
- Consumes: `StackView[]` + draft counts from existing `stacks.list` / `source.countDrafts`
- Produces: search input, collapsible repo sections, folder subheaders, sessionStorage key `sm.stacks.collapse.{workspaceId}`

- [ ] **Step 1: Server page loads data and renders client island**

```tsx
// stacks/page.tsx — keep empty state; otherwise:
const items = list.map((s, i) => ({
  id: s.id,
  name: s.name,
  rootPath: s.rootPath,
  draftCount: drafts[i] ?? 0,
  repository: { id: s.repository.id, name: s.repository.name },
}));
return (
  <>
    <PageHeader title="Stacks" description="Compose stacks defined in your repositories. Open one to edit its source." />
    <OrganisedStacks workspaceId={workspaceId} stacks={items} />
  </>
);
```

- [ ] **Step 2: Client island behaviour**

- Search filters via `filterStacks` then `groupStacks`.
- Empty search results: “No stacks match.”
- Collapse state: `sessionStorage` JSON map `repositoryId → boolean` (default expanded).
- Rows: name, `rootPath || '(root)'`, draft pill, chevron — same list-row patterns as today.
- Use existing CSS classes (`list`, `list-row`, `pill`, `muted`, `mono`); avoid new card chrome.

- [ ] **Step 3: Unit tests already cover grouping; optional lightweight render not required.**

- [ ] **Step 4: Verify** `pnpm check`

---

### Task 4: Dashboard (full)

**Files:**
- Modify: `src/app/w/[workspaceId]/page.tsx`
- Modify: `src/server/application/source-service.ts` — add workspace draft attention helper
- Create (optional): `src/ui/dashboard/*` if page gets crowded
- Create: `src/shared/audit/labels.ts` + `tests/unit/audit-labels.test.ts` (also used by Activity)

**Source helper (add to SourceService):**

```ts
/** Drafts in the workspace that are outdated vs current tree blobs (needs attention). */
async listOutdatedDraftSummaries(
  workspaceId: string,
): Promise<Array<{ repositoryId: string; path: string; stackId?: string }>>
```

Implementation sketch: list repositories in workspace; for each with `headSha`+`clonePath`, `drafts.list(repoId)`; build path→entry map like `#snapshot`; filter `isOutdated`; optionally map path to stack via `stacks.list` / `isWithin(rootPath)`. Keep return free of draft content.

Also useful for “stacks that have drafts”: reuse `countDrafts` per stack (already on stacks page) or a single pass listing drafts per repo.

**Dashboard sections (design):**

1. `PageHeader` — workspace name; description “Source workspace overview”
2. Summary strip — counts: repositories, stacks, open drafts; sync breakdown (`ready` / `syncing` / `error` / `pending`)
3. Needs attention — linked rows: sync error repos, stacks with drafts, outdated drafts; empty: “Nothing needs attention.”
4. Shortcuts — Stacks, Repositories, Settings; Connect repository if zero repos (empty state already covers zero)
5. Recent activity — `audit.list({ workspaceId, limit: 8 })` with human labels + target links when resolvable

**Audit labels:**

```ts
// src/shared/audit/labels.ts
const LABELS: Record<string, string> = {
  'auth.login': 'Signed in',
  'auth.logout': 'Signed out',
  'auth.login_failed': 'Sign-in failed',
  // add known actions from audit.record call sites — grep `action: '`
};
export function auditActionLabel(action: string): string {
  return LABELS[action] ?? action;
}
```

Grep `action: '` under `src/server` to populate the map comprehensively.

**Activity target links:** map `entityType`/`entityId` when known (`repository` → `/repositories/{id}`, `stack` → `/stacks/{id}`); otherwise plain text.

- [ ] **Step 1: Tests for `auditActionLabel`**
- [ ] **Step 2: Implement labels + source outdated helper + unit/integration coverage for helper if non-trivial**
- [ ] **Step 3: Build Dashboard page**
- [ ] **Step 4: `pnpm check`**

---

### Task 5: Settings split (General / Credentials / Activity)

**Files:**
- Create: `src/app/w/[workspaceId]/settings/layout.tsx` — sub-nav links
- Modify: `src/app/w/[workspaceId]/settings/page.tsx` — General only (rename form)
- Create: `settings/credentials/page.tsx` — move credentials section; empty CTA → connect repository; show “Used by” repository names for attached credentials
- Create: `settings/activity/page.tsx` — ~25 events, labels, outcome badges, target links; redaction unchanged (`audit.list` already returns stored events)

**Settings layout pattern:**

```tsx
const tabs = [
  { href: `${base}`, label: 'General', match: (p: string) => p === base },
  { href: `${base}/credentials`, label: 'Credentials', match: (p) => p.startsWith(`${base}/credentials`) },
  { href: `${base}/activity`, label: 'Activity', match: (p) => p.startsWith(`${base}/activity`) },
  { href: `${base}/account`, label: 'Account', match: (p) => p.startsWith(`${base}/account`) },
];
```

Use a small client or server nav with `usePathname` in a client `SettingsNav` component under `src/ui/settings/settings-nav.tsx`.

`PageHeader` title “Settings”; layout wraps children. Each page may set section heading.

- [ ] **Step 1: Extract pages from monolithic settings**
- [ ] **Step 2: Credentials “Used by”** — for each credential, list `repositories.filter(r => r.credential?.id === c.id).map(r => r.name)`
- [ ] **Step 3: Activity uses `auditActionLabel`**
- [ ] **Step 4: Update e2e** — Settings still reachable; click Credentials / Activity tabs
- [ ] **Step 5: `pnpm check`**

---

### Task 6: Account — ports, AuthService, APIs

**Files:**
- Modify: `src/server/application/ports.ts`
- Modify: `src/server/persistence/sqlite/repositories.ts` (`SqliteSessionRepository`, `SqliteUserRepository`)
- Modify: `src/server/application/auth-service.ts`
- Create: `src/app/api/auth/password/route.ts`
- Create: `src/app/api/auth/sessions/route.ts`
- Create: `src/app/api/auth/sessions/[sessionId]/route.ts`
- Extend: `tests/integration/auth.test.ts`

**Port extensions:**

```ts
export interface SessionRepository {
  // existing...
  listByUser(userId: string, now: Date): Promise<Session[]>;
  deleteForUser(userId: string, sessionId: string): Promise<boolean>;
  deleteOtherSessions(userId: string, keepSessionId: string): Promise<number>;
}

export interface UserRepository {
  // existing...
  updatePasswordHash(id: string, passwordHash: string, updatedAt: Date): Promise<void>;
}
```

**AuthService methods:**

```ts
async changePassword(
  userId: string,
  currentSessionId: string,
  input: { currentPassword: string; newPassword: string },
  ctx: RequestContext,
): Promise<void>

async listSessions(userId: string, currentSessionId: string): Promise<Array<{
  id: string;
  createdAt: string;
  lastSeenAt: string;
  userAgent: string | null;
  current: boolean;
}>>

async revokeSession(userId: string, sessionId: string, currentSessionId: string): Promise<void>
// throw ValidationError if sessionId === currentSessionId — use Sign out instead

async revokeOtherSessions(userId: string, currentSessionId: string): Promise<number>
```

Password change rules:
- Verify current with `verifyPassword`; on failure throw `AuthenticationError('Invalid username or password.')` or a generic “Current password is incorrect.” matching product tone (no enumeration beyond existing norms).
- `validateNewPassword` + username-contains check (load user).
- `updatePasswordHash` with Argon2id via `hashPassword`.
- After success: `deleteOtherSessions`, audit `auth.password_changed`, keep current session.

**Routes (auth: `user`):**

- `POST /api/auth/password` body `{ currentPassword, newPassword, confirmPassword }` — confirm mismatch → field error
- `GET /api/auth/sessions` → `{ sessions: [...] }`
- `DELETE /api/auth/sessions` → revoke others (`{ revoked: number }`)
- `DELETE /api/auth/sessions/[sessionId]` → revoke one

Never return hashes/tokens. Session `id` in API responses is the **hashed** session id already stored (same as DB) — fine for revoke; do not expose cookie token.

- [ ] **Step 1: Failing integration tests for change password + list/revoke**
- [ ] **Step 2: Implement ports + sqlite + AuthService + routes**
- [ ] **Step 3: Tests pass; confirm route coverage still discovers new routes**

---

### Task 7: Account UI

**Files:**
- Create: `src/app/w/[workspaceId]/settings/account/page.tsx`
- Create: `src/ui/account/change-password-form.tsx`
- Create: `src/ui/account/sessions-panel.tsx`
- Use `api()` from `src/ui/api.ts` like `SignOutButton`

**Behaviour:**
- Change password form: current + new + confirm; field errors from API
- Sessions table: created / last seen / user-agent / “Current” marker; Revoke on others; “Sign out everywhere else” button
- Sidebar Sign out remains

- [ ] **Step 1: Wire Account page (RSC can pass initial sessions from AuthService.listSessions via layout session)**
- [ ] **Step 2: Client forms for mutations**
- [ ] **Step 3: Optional e2e smoke — change password if harness allows; otherwise integration tests suffice**
- [ ] **Step 4: `pnpm check`**

---

### Task 8: Docs + e2e polish + final verification

**Files:**
- `docs/public/getting-started.md` / `docs/internal/UX.md` — mention Dashboard home and settings tabs if user-facing
- `docs/internal/INDEX.md` — link this plan if not already
- `docs/internal/plans/2026-09-30-dashboard-stacks-settings-design.md` — status → implemented (when done)
- `tests/e2e/shell.spec.ts` — full nav order assertion

- [ ] **Step 1: Update docs for IA change**
- [ ] **Step 2: Playwright**

```ts
const nav = await openNav(page);
await expect(nav.getByRole('link', { name: 'Dashboard' })).toHaveAttribute('aria-current', 'page');
await expect(nav.getByRole('link', { name: 'Stacks' })).toBeVisible();
await expect(nav.getByRole('link', { name: 'Repositories' })).toBeVisible();
await expect(nav.getByRole('link', { name: 'Settings' })).toBeVisible();
```

- [ ] **Step 3: Run `pnpm check` and `pnpm build`**
- [ ] **Step 4: Run `pnpm test:e2e` (shell suite at minimum)**
- [ ] **Step 5: `graphify update .`**
- [ ] **Step 6: Mark design doc status implemented; close/update ADHD issue #14 resume notes**

---

## Self-review

**Spec coverage:**
| Design requirement | Task |
| --- | --- |
| Dashboard home + brand/landing | 2, 4 |
| Nav order Dashboard → Stacks → Repositories → Settings | 2 |
| Organised stacks grouping + search + collapse | 1, 3 |
| Settings split General/Credentials/Activity/Account | 5, 6, 7 |
| Account password + sessions APIs | 6, 7 |
| Product boundary / no cron/webhooks/git | Global constraints |
| Tests unit/integration/e2e | 1, 4, 6, 8 |

**Placeholder scan:** none intentional; Account UI may reuse existing form field patterns from login — implementers should mirror `src/ui` login form styles, not invent a new system.

**Type consistency:** `GroupableStack` / `groupStacks` names used in Tasks 1 and 3; Auth session list shape shared by Task 6 API and Task 7 UI.

---

## Execution handoff

Plan saved to `docs/internal/plans/2026-09-30-dashboard-stacks-settings-implementation.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks  
2. **Inline Execution** — execute tasks in this session with executing-plans checkpoints  

Which approach?
