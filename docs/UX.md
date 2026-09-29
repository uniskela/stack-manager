# Desktop, mobile, and PWA UX

Current-state review and concrete improvement work: [plans/UI_UX_PLAN.md](plans/UI_UX_PLAN.md).

## UX hierarchy

1. **Source editing** is primary
2. Git changes / validation are secondary chrome
3. Runtime status is **contextual and deliberately secondary**
4. Deployment Watch appears during/after deploy — CI-like, not a Docker homepage

## Stack page structure

**Header:** stack name + optional runtime strip (health, container count, image, last refresh)

**Tabs:** Compose | Files | Docs | Environment | Secrets | Changes | Deployments

No primary nav items for Containers / Images / Networks / Volumes.

Implemented in PR #3: **Editor** (explorer, tabs, problems, status bar), **Docs**, **Environment**, **Changes** and
**Settings** tabs. Secrets and Deployments arrive with PR #6 and PR #5.

## Desktop

- Multi-pane optional: file tree + editor + problems
- Diff review full-width
- Command palette for stack switching / actions (idea from prior art; implement later)

## Mobile

Mobile editing is a **first-class** requirement.

- Single-column stack page
- Editor uses CodeMirror 6 with soft-wrap, large tap targets, minimal chrome
- Bottom sheet for file switcher / validation errors
- Avoid hover-only actions
- Runtime strip collapsible
- Deploy confirmations use explicit full-screen review of routing decision

## PWA (PR #8)

- Installable manifest + service worker
- Offline-safe **drafts** for in-progress edits (not offline deploy)
- Clear “you are offline” affordance; mutating Git/deploy requires network
- Do not cache credentials or encrypted blobs in SW incorrectly

## Accessibility

- Keyboard navigation for editor chrome and tabs
- Preferable contrast; respect `prefers-reduced-motion`
- Log and diff views remain copyable as plain text

## Empty / no-runtime states

- Explain that runtime is optional
- CTA to bind runtime **or** continue with Git-only
- Routing explanations always visible before deploy

## Anti-patterns

- Dashboard of all containers across hosts as home
- Floating Docker stats widgets dominating the editor
- Autocomplete that pulls live secret values into the buffer by default
