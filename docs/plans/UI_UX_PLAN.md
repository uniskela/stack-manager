# UI/UX review and improvement plan

Review of the UI shipped in PR #2 (application foundation), with a phased plan to make it **user friendly, efficient and professional** without breaking the product boundary ([PRODUCT.md](../PRODUCT.md), [ADR 0005](../adr/0005-product-boundary.md)) or pulling later-phase features forward ([MVP_PLAN.md](MVP_PLAN.md)).

Companion to [UX.md](../UX.md), which remains the source of truth for UX _principles_. This document covers the _current state_ and _concrete work_.

## Method

- Read every page (`src/app/**/page.tsx`, layouts) and UI component (`src/ui/*`) plus `globals.css`.
- Ran the app locally and walked the full journey with Playwright at 1280×860 (desktop) and 390×844 (mobile, touch): first-run setup → workspace → connect repository (success and validation-error paths) → repository detail → repository list → settings → 404.

## What already works well

Keep these; the plan builds on them rather than replacing them.

- **Calm, restrained visual language.** Neutral palette, one accent, system fonts, tokens in `:root`, automatic dark mode. It reads as a tool, not a dashboard, which suits the product.
- **Guided first run.** Three-step progress indicator (Admin → Workspace → Repository), sensible defaults (`admin`, `Homelab`), and a "Skip for now" exit.
- **Good security UX.** "Test connection" before connecting, remote HEAD preselected, replace-only secrets, "never shown after saving", and a hint against putting tokens in URLs.
- **Solid accessibility baseline.** Skip link, `:focus-visible` outlines, labelled fieldsets, `aria-invalid`/`aria-describedby` on fields, `role="status"`/`role="alert"`, 44 px touch targets, `prefers-reduced-motion`.
- **Mobile basics.** Single column, stacked metadata grid, full-width action buttons.
- **Honest copy.** Explains what happens on connect (clone in background) and on remove (remote untouched, credentials kept).

## Findings

Severity: **H** = fix before PR #3 builds on it, **M** = fix as part of the next UI touch, **L** = polish.

### 1. Information architecture and navigation

| # | Sev | Finding | Evidence |
| --- | --- | --- | --- |
| 1.1 | H | The top bar can't hold the stack-centric navigation that PR #3 brings (stacks, files, changes). Right now it has only two items and Sign out. | `src/ui/nav.tsx` |
| 1.2 | H | **On mobile the logo link has no accessible name.** `.brand-text` is `display:none` below 640 px, which leaves an unlabeled blue square that is also the only way home. | `globals.css` `@media (max-width: 640px)`, `src/ui/brand.tsx` |
| 1.3 | M | On mobile the workspace breadcrumb is hidden, so nothing shows which workspace you're in. | `.crumb { display:none }` |
| 1.4 | M | The signed-in user appears only in a `title` tooltip, which touch and keyboard users can't reach. There's also no account menu (change password, sessions, sign out). | `w/[workspaceId]/layout.tsx` |
| 1.5 | M | Back navigation is an ad-hoc "← Repositories" link instead of a breadcrumb, so it won't scale to Workspace › Repository › Stack › File. | repository page |
| 1.6 | M | `Brand` uses a raw `<a>`, so clicking the logo does a full page reload. | `src/ui/brand.tsx` |
| 1.7 | L | No way to switch workspaces. The home page always redirects to the first one. | `src/app/page.tsx` |

### 2. Onboarding and forms

| # | Sev | Finding | Evidence |
| --- | --- | --- | --- |
| 2.1 | M | Step 3 of onboarding jumps from the centered auth card into the full app shell. It feels like you've left the wizard, and "Skip for now" floats as a separate button above the card. | screenshots `03-connect` vs `02-onboarding` |
| 2.2 | M | Validation errors appear twice: a generic banner ("Invalid remote URL.") and the specific field error. The banner scrolls focus away from the field that's wrong. | screenshot `09-connect-error` |
| 2.3 | M | Obvious mistakes aren't caught before a round-trip to the server: `http://` URLs, a token in the URL, password mismatch only checked on submit, and no password-strength or length feedback while typing. | `connect-repository-form.tsx`, `setup-form.tsx` |
| 2.4 | M | The connection-test result is a small pill. Long failure messages overflow it, and it gives no next step (e.g. "check token scope", "enable private networks"). | `connect-repository-form.tsx` |
| 2.5 | M | Every edit to the URL or token clears the test result, which gets noisy while typing. It should clear only when the value actually differs from the one that was tested. | `resetResult()` |
| 2.6 | L | Password fields have no show/hide toggle, and the login form has no "caps lock on" hint. | `form.tsx` |
| 2.7 | L | Provider radios still show the native radio dot inside the segmented control. The UI is visually redundant and looks less finished. | `.segmented` |
| 2.8 | L | Form status messages ("Saved.", "Secret replaced…") stay on screen forever and are styled inconsistently: `muted` text in one place, `.alert` in another. | `workspace-form.tsx`, `credential-actions.tsx` |

### 3. Repository and data views

| # | Sev | Finding | Evidence |
| --- | --- | --- | --- |
| 3.1 | M | The status pill sits on the far right, away from the title on desktop, and wraps onto its own line on mobile. Status should sit next to the name. | screenshot `06-repo-later`, `m3-repo` |
| 3.2 | M | The destructive "Remove…" button sits in the same row as routine "Fetch now" / "Test connection". It needs its own danger zone. | `repository-actions.tsx` |
| 3.3 | M | Nothing is actionable or copyable: the remote URL and HEAD SHA are plain text, with no copy button and no link to the forge. | repository page |
| 3.4 | M | The default branch isn't marked or pinned among the branch chips, and the list is uncapped (hundreds of branches will flood the page). | repository page |
| 3.5 | M | Sync errors show the raw message with no help text, no timestamp and no "retry now". | repository page alert |
| 3.6 | M | Repository list rows put three stacked lines of metadata on the right. On mobile that squeezes the name to `uniskela/stack-mana…`. | screenshot `m1-repos` |
| 3.7 | L | `LocalTime` never re-renders ("just now" stays forever), and anything older than 24 h switches to a long locale string. Relative times should keep updating, with the absolute time on hover or long-press. | `local-time.tsx` |
| 3.8 | L | Polling uses `router.refresh()` every 2 s with no backoff, and the page doesn't say it's live-updating. | `repository-actions.tsx` |

### 4. Settings and audit

| # | Sev | Finding | Evidence |
| --- | --- | --- | --- |
| 4.1 | M | One long page mixes workspace name, credentials and audit. Account settings (password, sessions) are missing. | settings page |
| 4.2 | M | The activity table shows raw codes (`repository.sync`) and plain-text outcomes. There's no actor, no target (which repository), no filter and no pagination beyond 25. | screenshot `08-settings` |
| 4.3 | L | Credential rows cram kind, provider, hint, user and updated date into one muted line. | settings page |
| 4.4 | L | The empty credentials state is plain text, with no card and no CTA. | settings page |

### 5. Design system and code quality

| # | Sev | Finding | Evidence |
| --- | --- | --- | --- |
| 5.1 | H | 15 inline `style={{…}}` props bypass the tokens, so layout fixes have to be made page by page. | `grep -rn "style={{" src` |
| 5.2 | H | No shared primitives beyond `Field`/`StatusPill`. Buttons, alerts, cards, page headers and confirmation patterns are re-implemented per component. PR #3 (editor, file tree, tabs) will multiply this. | `src/ui/*` |
| 5.3 | M | No icon set. Everything is text-only, so dense chrome (file tree, tabs, toolbars) in PR #3 will need icons. | — |
| 5.4 | M | No `loading.tsx` or `error.tsx` boundaries. Slow DB or Git calls show a blank page, and server errors show the framework default. | `src/app` |
| 5.5 | M | No favicon, app icon or manifest. Browser tabs show a generic icon. (The PWA manifest itself stays in PR #8; a favicon doesn't need to wait.) | no `public/` or `icon` |
| 5.6 | L | No manual light/dark/system theme override. | `globals.css` |
| 5.7 | L | No UI tests: no Playwright smoke test, no axe accessibility check, no visual snapshots. | `tests/` |

## Plan

Each phase is sized as one reviewable PR (or folded into the phase PR noted), so nothing from later MVP phases is built early.

### Phase UI-1 — Foundation polish (small PR before or at the start of PR #3)

> **Status: implemented** alongside this plan. Deviations from the original list below:
>
> - The account block (avatar, username, Sign out) sits in the **sidebar footer** rather than a top-bar menu, and
>   breadcrumbs render at the top of each page. On desktop this removes the top bar entirely, which leaves more
>   vertical space for the PR #3 editor. The sidebar isn't collapsible yet: with two items it doesn't need to be.
> - `CopyButton` moved to UI-3, where the repository header first uses it.
> - As part of adopting `ConfirmButton`, "Remove repository" moved into a **Danger zone** section (the UI-3 item,
>   minus the type-the-name confirmation). The repository list also stacks its metadata under the name on mobile.

Goal: fix the **H** findings and give PR #3 a design system to build on. No new product features.

1. **Tokens and primitives** (5.1, 5.2)
   - Extend `:root` tokens: spacing scale (`--space-1…8`), type scale, z-index layers, motion durations.
   - Add `src/ui/primitives/`: `Button` (variants `primary | secondary | danger | ghost`, sizes, `loading` state), `Alert`, `Card`/`Section`, `PageHeader` (title, description, status, actions), `EmptyState`, `ConfirmButton` (the inline two-step confirm used today, standardised), `Badge`/`StatusPill`.
   - Replace every inline `style={{}}` with a utility class or primitive. Add a lint rule (`react/forbid-dom-props` for `style`) to keep it that way.
   - Keep plain CSS (no Tailwind or UI-kit dependency); split `globals.css` into `tokens.css`, `base.css` and `components.css`.
2. **App shell ready for PR #3** (1.1–1.6)
   - Desktop: collapsible **left sidebar** (Workspace switcher at top → Repositories → _(Stacks, added in PR #3)_ → Settings), with a slim top bar holding breadcrumbs and an account menu.
   - Mobile: top bar with menu button (sidebar becomes a drawer), current page title, and account menu. Always show the workspace name in the drawer.
   - `Breadcrumbs` component, replacing the ad-hoc "← Repositories" link.
   - `Brand`: switch to `next/link`, add `aria-label="stack-manager home"`, and show a real SVG mark.
   - Account menu: username, Sign out (Change password is added in UI-3).
3. **Route boundaries** (5.4): `loading.tsx` (skeletons that match `PageHeader` + list) and `error.tsx` (friendly message, retry, link home) at `w/[workspaceId]`; restyle `not-found.tsx` inside the shell when signed in.
4. **Favicon/app icon** (5.5): an SVG icon via the `app/icon.svg` convention. The manifest stays in PR #8.
5. **Icons** (5.3): add `lucide-react` (tree-shaken, MIT). Use icons only to support text labels, never as the only affordance.
6. **Tests** (5.7): a Playwright smoke test of the onboarding journey, plus `@axe-core/playwright` on each page at desktop and mobile widths, run in CI.

Exit: zero inline styles, sidebar shell live, axe clean, `pnpm check` and `pnpm build` green.

### Phase UI-2 — Forms and feedback (same or next small PR)

1. **Validation** (2.2, 2.3): client-side checks that mirror the server's zod rules (https only, no userinfo in the URL, password ≥ 12 and matching, live). On a server error, focus the first invalid field. Show the banner only for errors that don't belong to a field.
2. **Connection test** (2.4, 2.5): show the result as an inline `Alert` with a title, the message, and a mapped **next step** per `reason` code (auth, not found, network blocked → mention `STACK_MANAGER_ALLOW_PRIVATE_NETWORKS`, TLS). Invalidate the result only when the tested inputs actually change.
3. **Onboarding continuity** (2.1): render step 3 in the same centered wizard layout with "Skip for now" as a secondary action in the form footer. After connecting, land on the repository page with a one-time "Next: discover stacks" hint (a placeholder until PR #3).
4. **Toasts** (2.8): a lightweight `aria-live` toast region for transient success ("Saved", "Secret replaced", "Fetch queued"). Errors stay inline next to their cause.
5. **Inputs** (2.6, 2.7): password reveal toggle, caps-lock hint on login, segmented control without visible radio dots (still native inputs, so keyboard and screen readers keep working).

### Phase UI-3 — Views and settings (fold into PR #3 where it touches the same pages)

1. **Repository page** (3.1–3.5)
   - `PageHeader`: name + status badge together, then a meta line with a copyable remote, a forge-linked short SHA with copy, the default branch and "fetched 3 min ago".
   - `CopyButton` primitive for the remote URL and SHA.
   - Actions: primary "Fetch now", secondary "Test connection". The **Danger zone** (added in UI-1) gains a type-the-repository-name confirmation.
   - Branches: default branch pinned and marked, with filter and "show all (n)" past 20.
   - Sync error: `Alert` with a summary, timestamp, attempt count, a "Retry now" button and a collapsible raw detail.
   - This page becomes the host for PR #3's stack list, so reserve a "Stacks" section with an empty state now (no discovery logic yet).
2. **Repository list** (3.6): the name and remote take the full width; status and fetched-time go on one secondary line below; list search appears once there are more than 5 repositories.
3. **Time and live state** (3.7, 3.8): `LocalTime` ticks every minute and shows the absolute time in a tooltip or on long-press. Polling backs off (2 s → 5 s → 15 s), pauses when the tab is hidden, and shows a subtle "Syncing…" indicator.
4. **Settings split** (4.1): sub-navigation for **General** (workspace name), **Credentials**, **Activity** and **Account** (change password, active sessions, sign out everywhere) as separate routes under `settings/`. The Account page needs only the existing auth/session tables. If a missing API makes this scope creep, defer Account to PR #8.
5. **Activity** (4.2): human labels ("Fetched *repo*", "Connected *repo*"), outcome badges, actor, target link, filter by type or outcome, and cursor pagination. Redaction rules stay unchanged.
6. **Credentials** (4.3, 4.4): card rows with a clear title, provider badge, masked hint, a "Used by" list of repositories and the last test result. The empty state gets a CTA to connect a repository.

### Phase UI-4 — Efficiency (PR #3/#4, alongside the features that need it)

These follow the PR sequence and don't come earlier:

- **Command palette** (`⌘K` / `Ctrl K`) for jumping to repositories and stacks and running actions (Fetch, Test). This is already listed in [UX.md](../UX.md); build it once stacks exist to navigate (PR #3).
- **Keyboard shortcuts**: `g r` repositories, `g s` settings, `/` focus search, `?` shortcut sheet.
- **Editor chrome** (PR #3): tabs, file tree, problems panel and bottom sheet on mobile, as in [UX.md](../UX.md). They should reuse the UI-1 primitives.
- **Changes indicator** (PR #4): an uncommitted-changes badge in the sidebar and page header.

### Phase UI-5 — Professional finish (PR #8)

- Theme override (system/light/dark) saved per user (5.6).
- PWA manifest, offline banner and draft recovery UI (already scoped in PR #8).
- Visual regression snapshots for key pages in light and dark mode.
- Contrast audit of every token pair to WCAG 2.2 AA, including focus rings on the tinted pills and buttons.
- Content pass: consistent sentence case, verbs on buttons, no jargon without a hint.

## Guardrails

- **Product boundary:** none of this adds Containers, Images, Networks or Volumes navigation, or runtime-first homepages. Runtime status stays contextual (UX.md hierarchy).
- **Phase discipline:** UI-1/UI-2 only restyle and restructure existing PR #2 features. Anything that needs new domain data waits for its MVP phase.
- **Security:** no new client-side storage of secrets. The copy buttons never touch credentials, toasts never echo secrets, and the activity labels keep the redacted payloads.
- **Dependencies:** at most `lucide-react` (runtime) plus `@playwright/test` and `@axe-core/playwright` (dev). No component framework.

## Success criteria

- New user reaches a connected repository in ≤ 3 screens with no validation round-trip for obvious mistakes.
- Every page passes axe with zero serious or critical violations at 390 px and 1280 px, light and dark.
- No inline styles; every page uses `PageHeader` and the shared primitives.
- Destructive actions are always separated and need a deliberate confirmation.
- Every async action shows its pending state and gives feedback within 100 ms.
