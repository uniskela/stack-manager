# Stacks page: UI/UX audit and improvement plan

**Status:** Step 0 and S1 done; S2–S5 not started.
**Date:** 2026-09-30
**Scope:** `/w/{workspaceId}/stacks` (the inventory list) and the handful of touch-points that make it easy to get into and back out of a stack. Follows slice A ([design](./2026-09-30-dashboard-stacks-settings-design.md)), which shipped grouping, search and collapse.

## Goal

The Stacks page should be **clean**, **predictable to scan** (ordering you can rely on), and **fast to narrow down** (search, filters, sort) for a workspace with tens to hundreds of stacks across several repositories, on desktop and on a phone.

## Method and limits

Read `src/app/w/[workspaceId]/stacks/page.tsx`, `src/ui/stacks/organised-stacks.tsx`, `src/shared/stacks/group-stacks.ts`, the `.list`/`.list-row`/`.pill`/`.search-field` CSS, the stack layout/tabs, `StackService`, `docs/UX.md` and the earlier UI plans.

The first pass was read-only, so visual findings were inferred from markup and CSS. Step 0 then ran a production build with a seeded dataset and checked them against screenshots (results below).

## What works today (keep)

- Sensible grouping: repository → first path segment → stack name, stable sort (`groupStacks`, unit-testable, in `src/shared`).
- Search over name, repository and full path; empty-search message; dedicated zero-stacks empty state.
- Collapse state survives navigation (sessionStorage, with an in-memory fallback), `aria-expanded` on headers.
- Draft pill on rows; whole row is the link; 56 px row height suits touch.
- Shared primitives (`PageHeader`, `EmptyState`, tokens) already exist; the page is small and pure enough to rework safely.

## Findings

Severity: **H** = broken or misleading, **M** = clear friction, **L** = polish.

### A. Correctness / misleading behaviour

| # | Sev | Finding | Evidence |
| --- | --- | --- | --- |
| A1 | H | **Search does not open collapsed groups.** If a repository is collapsed and the query matches stacks inside it, those rows stay hidden and the page shows neither results nor "No stacks match". | `open = !isRepoCollapsed(...)` ignores `query`; empty message only when `filtered.length === 0` |
| A2 | M | **Numbered folders sort wrongly.** `localeCompare` without `numeric: true` puts `100-casaos` before `20-media`, and `stack10` before `stack2`. The real data uses numeric prefixes. | `group-stacks.ts` (repo, folder and name sorts) |
| A4 | L | **A root-level stack counts every draft in its repository.** A stack at the repository root (`rootPath` `''`) scopes the whole repository, so its pill showed "4 drafts" for drafts that belong to other stacks. This is consistent with the stack's scope but reads as wrong next to those stacks' own pills. Decide in S2: keep, or count only drafts outside every other stack. | `countDrafts(repo, '')` → all drafts; seen in the Step 0 baseline |
| A3 | M | **Search and collapse state are lost on the way back.** Opening a stack and pressing Back/breadcrumb "Stacks" returns to an unfiltered list; the query is not in the URL and cannot be shared or bookmarked. | `useState('')` in `OrganisedStacks`; breadcrumb is a plain link |

### B. Visual hierarchy and cleanliness

| # | Sev | Finding | Evidence |
| --- | --- | --- | --- |
| B1 | M | **Three levels look like one.** Repository headers, folder subheaders and stack rows all use `.list-row` with the same height, padding and divider. Headers are distinguished only by a chevron and (for folders) muted text. On long lists you can't see where a group starts. | `organised-stacks.tsx`, `.list-row` |
| B2 | M | **Headers carry no information.** No stack count, no draft total, no sync state, no link to the repository. A collapsed repository is a blank line. | repo header renders `repositoryName` only |
| B3 | M | **Folder subheaders are dead rows** (not collapsible, no count) yet take a full 56 px row. They also only appear when a repo has >1 folder, so layout shifts between repos. | `repo.folders.length > 1` |
| B4 | L | **Rows repeat themselves.** The path line usually just restates the folder header plus the name (`100-casaos/apprise` under "100-casaos"). The trailing chevron duplicates "whole row is a link". | row markup |
| B5 | L | **No page-level context.** Header has no stack count; no primary action (users must go to Repositories to add/auto-discover stacks); the description is generic. | `page.tsx` |
| B6 | L | **Draft pill reuses the "pending/warn" status style**, so a stack with drafts looks like something is wrong rather than "work in progress". It also has no icon, so it relies on colour. | `.pill.pending` |
| B7 | L | **Unfetched or failing repositories are invisible here.** A repo whose sync is in `error` or which has no `headSha` still lists its stacks as normal rows (the detail page then shows "Waiting for the first fetch"). | `StackView.repository.syncStatus` is fetched but unused |

### C. Search, filtering and ordering

| # | Sev | Finding | Evidence |
| --- | --- | --- | --- |
| C1 | H | **No filters at all.** Nothing for "has drafts", repository, or repositories needing attention. Drafts are the main reason to return to this page. | only `filterStacks` (substring) |
| C2 | M | **No sort control and no flat view.** Users can't choose name A–Z, path, or drafts-first, and can't see a plain alphabetical list of every stack across repositories. | fixed grouping |
| C3 | M | **Search is bare:** no result count, no clear (×) button, no `/` shortcut, no match highlighting, and it is a whole-string substring (no multi-word "media plex"). | `filterStacks` |
| C4 | M | **No bulk collapse/expand.** With 10+ repositories or folders the only option is clicking each header. | — |
| C5 | L | **Single-level folder grouping.** Only the first path segment is used, so `apps/media/plex` and `apps/media/sonarr` share one flat "apps" group. | `folderSegment` |

### D. Navigation and efficiency

| # | Sev | Finding | Evidence |
| --- | --- | --- | --- |
| D1 | M | **Inside a stack there is no way to move sideways.** Switching to a sibling stack means Back → find it again (see A3). The breadcrumb is `Stacks › name` and drops the repository/folder context. | `stacks/[stackId]/layout.tsx` |
| D2 | M | **No keyboard path** (`/` to search, arrow keys in the list, Enter to open). Command palette is planned (UI-4) but not built. | [UI_UX_PLAN.md](./UI_UX_PLAN.md) UI-4 |
| D3 | L | **`countDrafts` runs once per stack** on every page load (N sequential-ish queries inside `Promise.all`). Fine today, will matter at hundreds of stacks. | `page.tsx` |

### E. Mobile and accessibility

| # | Sev | Finding | Evidence |
| --- | --- | --- | --- |
| E1 | M | **Toolbar room.** Once filters/sort exist, the search-only toolbar will not fit at 390 px; it needs a deliberate mobile layout (filters behind a sheet/disclosure). | `.search-field` is `min-width: 16rem` |
| E2 | L | **Results are silent to screen readers.** Filtering changes the list with no live region announcing "12 of 87 stacks". | no `role="status"` |
| E3 | L | **List semantics.** Repository/folder headers are `li` rows inside one flat `ul`, so assistive tech sees a single undifferentiated list with no grouping. | `ul.list` with mixed rows |

## Design direction

1. **Clear three-tier structure.** Repository = a card-like section header (name, stack count, draft count, sync badge, link to repository). Folder = a lighter, collapsible sub-label with count. Stack = a compact row. Each tier is visually distinct at a glance.
2. **Toolbar above the list** (sticky on scroll): search, filters, sort, group-by, expand/collapse all, and a live result count. One row on desktop; search + "Filters" disclosure on mobile.
3. **URL is the state.** Query, filters, sort and grouping live in search params so Back, refresh and sharing work; collapse state stays per-browser.
4. **Predictable ordering.** Natural (numeric-aware) sort everywhere; default order repository → folder → name; explicit alternatives offered rather than implied.
5. **Stay inside the product boundary** ([ADR 0005](../adr/0005-product-boundary.md)): every filter is about source state (drafts, sync, location). No runtime/container status, no deploy state.

## Plan

Each phase is one reviewable PR with Conventional Commit titles. Logic goes in `src/shared/stacks` (pure, unit tested); UI in `src/ui/stacks`; no API changes needed except where noted.

### Step 0 — Baseline (no code shipped)

- Install deps, run the app with a realistic dataset (multiple repos, numbered folders, some drafts, one failing repo), and capture screenshots of `/stacks` at 1280 px and 390 px, light and dark, empty / 5 / 150 stacks.
- Confirm or drop findings marked "inferred", especially B1, B3, E1.

**Done.** Production build, worker off, 112 stacks seeded into SQLite across four repositories (numbered folders, nested
monorepo paths, 8 drafts, one repository in `error` with no fetch), captured with Playwright at 1280 px and 390 px (Pixel
7), light and dark.

- **Confirmed:** A1 (query `authelia` with its repository collapsed gave 0 rows and no "No stacks match"), A2
  (`10-core`, `100-casaos`, `20-media`, `200-dev`, `3-network`; `stack1`, `stack10`, `stack2`), A3 (Back after
  searching `grafana` returned an empty search), B1/B3 (repository, folder and stack rows share one style and height;
  about 7 stacks fit above the fold at 1280 px), B7 (the failing repository's stacks look like the others).
- **Corrected:** C3 — Chromium already draws a native clear (×) in the search field; Firefox doesn't, so a custom one
  is still needed for consistency.
- **New:** A4 (root-stack draft count).

### Phase S1 — Fix what is wrong (fix: / small PR)

- **A1** When a query or any filter is active, treat all groups as expanded (don't mutate stored collapse state); restore on clear.
- **A2** Natural sort: `localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })` for repository, folder and stack names; add unit cases (`2` vs `10`, `100-x` vs `20-y`).
- **C3 (part)** Result count live region (`role="status"`, "12 of 87 stacks"), clear (×) button, `/` focuses search, Esc clears.
- Tests: extend the `group-stacks` unit tests; add an e2e for "search finds a stack inside a collapsed repository".

**Done.** Notes on what shipped:

- A1: while searching, every repository starts expanded. Headers still toggle, but only for that search: toggles reset
  when the query changes and never touch the saved (sessionStorage) layout, which comes back when the search is cleared.
- A2: one shared `Intl.Collator` (`numeric`, `sensitivity: 'base'`) via `naturalCompare`. The repository root group
  is always first, and equal stack names fall back to path and then id, so rows never swap between renders.
- C3: the count sits beside the search (below it on mobile) as `role="status"`. The custom clear button replaces the
  browser's own. A `/` hint shows inside the field on devices with a fine pointer. `/` is ignored while typing in
  another field or with a modifier key. The no-match state is an `EmptyState` with a **Clear search** action.
- Pulled forward from S3: multi-term search (every term must match, across name, repository and path). It is a
  three-line change and behaves exactly as before for single-word queries.
- Still open for S3: A3 (URL state) and match highlighting.

### Phase S2 — Structure and visual hierarchy (feat:)

- New row anatomy: stack name (title), folder path as secondary text only when it adds information (hide the segment already shown in the folder header), drafts badge with icon and neutral/accent styling distinct from error/warn, no trailing chevron (hover/focus affordance instead).
- **Repository header** (B2, B7): name, link to repository, "N stacks", total drafts, sync badge (`error`, `syncing`, "not fetched yet" shown inline with a one-line reason/link). Collapsed state still shows those counts.
- **Folder sub-label** (B3): collapsible, with count, always rendered for a consistent layout when a repo has any folders; the repository-root group is labelled "Repository root".
- **Nested folders** (C5): group by the full directory tree (collapse to a single chain where a folder has one child) — *decision needed, see below.*
- Page header (B5): stack count in the description; primary action "Add stacks" linking to Repositories (or the auto-discovery flow), kept secondary to content.
- Markup: nested `ul`s with headings or `role="group"` + `aria-labelledby` per group (E3).
- CSS: new `.stack-group`, `.stack-row` classes in `components.css` or a new `stacks.css`; no inline styles (lint-enforced).

### Phase S3 — Search, filters, sort (feat:)

- Toolbar component `StackListToolbar` (desktop single row; mobile: search + "Filters (n)" disclosure, E1).
- **Search:** multi-term AND across name, repository, path; highlight matches in the row (`<mark>`, contrast-checked).
- **Filters** (all combinable, shown as removable chips when active, with "Clear all"):
  - *Has drafts* (toggle)
  - *Repository* (select, or multi-select when >3 repos)
  - *Needs attention* (repository sync error / not fetched) — source state only
- **Sort:** Name A–Z (default), Path, Most drafts first.
- **Group by:** Repository → folder (default) · Repository only · None (flat list with the repository shown per row).
- **Expand all / Collapse all** (C4), disabled in flat mode.
- **URL state** (A3): `?q=&drafts=1&repo=<id>&attention=1&sort=&group=` via `useSearchParams` + `router.replace` (no history spam, debounced for typing). Invalid params fall back to defaults; unknown repo ids are ignored.
- Pure helpers in `src/shared/stacks`: `parseStackListState`, `serialiseStackListState`, `applyStackFilters`, `sortStacks`, extended `groupStacks`. Extend `GroupableStack` with `repository.syncStatus` and `repository.headSha !== null` (from `StackView`).
- Tests: unit tests for every helper and the URL round-trip; e2e for filter → open stack → Back restores the same view.

### Phase S4 — Moving around (feat:)

- **D1** Stack page breadcrumb becomes `Stacks › {repository} › {name}`; the "Stacks" crumb and browser Back return to the saved list state (keep the list URL in `sessionStorage`, or pass it as a `from` param validated as a same-origin `/w/{id}/stacks?…` path).
- Optional sibling switcher on the stack header (dropdown of stacks in the same repository/folder, natural sorted) — *decision needed.*
- **D2** List keyboard navigation: `↑/↓` moves focus between visible rows (roving tabindex), `Enter` opens, `Home/End`. Build the command palette (`⌘K`) only if the owner wants to pull UI-4 forward; otherwise leave it on the existing roadmap.
- **D3** Replace N `countDrafts` calls with one aggregated query per repository (new `SourceService.countDraftsByStack`/by repository), behind the existing port; add a unit test. Do this only if the baseline measurement shows it matters.

### Phase S5 — Finish (docs/test)

- Axe on `/stacks` at 390 px and 1280 px, light/dark, with filters open and with a chip row; check focus order and the live region.
- Update `docs/UX.md` ("Stacks — organised inventory (groups, search, filters, sort)"), `docs/getting-started.md` (how to find a stack), and mark this plan's status. List nothing new in `docs/manifest.json` unless a new user-facing page appears.
- Add this plan to `docs/INDEX.md` (note: that file currently has uncommitted changes in the working tree, so reconcile before editing).
- `pnpm check` and `pnpm build` green; `pnpm test:e2e` with `E2E_GIT_REMOTE`/`E2E_STACK_ROOT` for the editor-dependent tests.

## Out of scope

- Any runtime, container or deploy status in the list (product boundary).
- Favourites/pins, tags, user-defined folders (deferred in slice A; revisit only if filters prove insufficient).
- Virtualised rendering — only if the baseline shows jank past ~500 stacks.
- Changing the stack detail tabs or the editor.
- Anything from PR #4+ (commit, push, deploy).

## Decisions for the owner

1. **Nested folders vs. first segment only** (S2). Recommendation: full tree with single-child chains collapsed; it matches how monorepos actually nest and costs little once grouping is tree-based.
2. **Sibling stack switcher in the stack header** (S4). Recommendation: yes — it is the cheapest fix for "go back, find it again", and needs no new data.
3. **Filter state in URL vs. session only** (S3). Recommendation: URL (shareable, survives refresh, fixes Back).
4. **Command palette now or per the UI-4 roadmap** (S4). Recommendation: leave on the roadmap; S3's toolbar plus `/` covers the need.

## Success criteria

- A stack among ~150 is found in ≤ 3 interactions (type, or one filter + scroll) on desktop and mobile.
- Collapsed groups never hide search results; the result count is always visible and announced.
- Each of the three tiers is distinguishable without reading the text; counts and problems are visible on collapsed headers.
- Reload, Back and a pasted link reproduce the same filtered, sorted view.
- Numeric folder names sort the way a person expects.
- Axe clean at 390 px and 1280 px, light and dark; no inline styles; `pnpm check` and `pnpm build` green.
