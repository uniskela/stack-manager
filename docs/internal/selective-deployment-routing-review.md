# Issue #55 implementation and review evidence

Branch: `feat/selective-deployment-routing`. Dependency #65 merged at `e75bda3`; #64 and #65 implementation
and published review records were inspected. No competing routing PR was open at preparation.

## Implemented behavior

- Pure bounded evaluator, explicit registered roots and include/exclude/dependency policy. No dependency added.
- Authoritative local commit comparisons: fast-forward ancestry, 1,000 commits, 10,000 paths, no working-tree
  content reads or webhook-supplied path authority. Renames preserve both sides as delete/add.
- Explicit default-off automatic deployment, optimistic revisions, saved baseline and non-sending sample preview.
- Verified forge pushes authorize routing; in-app pushes await their matching forge webhook. Manual fetches
  and polling alone never deploy. Saving automatic settings deliberately establishes the current baseline.
- Migration `0010_large_salo` adds checkpoints, routing decisions, safe source metadata and acknowledgement
  state. Existing bindings remain opted out. Delivery acceptance snapshots active stack references.
- Fetch success and routing continuation commit atomically. Source decisions, attempt jobs and checkpoints
  commit atomically under lease/revision fences. Delivery/body and per-source/stack uniqueness survive restart.
- Per-stack active attempts serialize manual/automatic work. Later active-at-receipt intents remain visibly
  blocked for manual action; unknown outcomes hold automation across binding replacement. Only deliberate
  manual requests acknowledge earlier unknown outcomes. Existing provider transport/send-intent safeguards apply.
- Compact attempt/decision history; routine successful routing/skip activity is filtered from the dashboard.

## Independent review corrections

1. A routing worker could run before fetch success was committed. Added the generic atomic success/continuation
   contract; regression aborts continuation insertion and verifies fetch success rolls back too.
2. Active intent could become eligible after its prior attempt finished. Snapshot active stack IDs at verified
   receipt and retain blocked decisions even after completion; arrival-time regression added.
3. Binding removal could erase an unknown-outcome hold. Preserve unresolved unknown attempt acknowledgements
   by stack and apply later unknown completion to the current binding; recreation regression added.
4. Changing branches could expose the old branch baseline. Immediately invalidate readiness/HEAD and compare-and-swap
   fetched metadata against its tracked branch; opt-in regression added.

## Validation

- Frozen dependency install with ignored scripts and approved native rebuild completed; no dependency change.
- Final `pnpm check`: format/lint/typecheck and 654 tests passed, including the branch-completion fence.
- Targeted Git/workflow/jobs/SQLite routing regressions: 79 passed.
- Migration generation reports no schema changes after migration 0010.
- Production build and full Playwright/axe run against the public sample repository passed: 43 passed,
  13 intentional skips (duplicate viewport/shared mutations and separate worker-disabled/server scenarios).
  [Desktop screenshot](screenshots/issue-55-desktop.png) and [mobile screenshot](screenshots/issue-55-mobile.png).
- CI on implementation commit `a334bbe` passed tests, migration drift, build and production smoke; remaining
  CI/security jobs and Kody/SonarCloud disposition are pending. CodeQL's external PR analysis reported no new alerts.
- Rootless Docker is configured. Low host disk space prevents a fresh local image build. CI now runs the
  production smoke script, restarts the container and verifies persisted workspace data and routing migration.
  Its execution result is pending; no host/network security settings were changed.

## Operator acceptance and residual risk

No production webhook, release, image publication or production deployment is authorized/performed. Before
production opt-in, verify a disposable GitHub/Gitea/Forgejo → receiver path, exact Portainer edition/version,
reverse proxy/TLS/private-network policy, receiver inspection after unknown outcomes and a consistent backup
restore. HTTP acceptance is not container health. Rule/history limits fail closed. Blocked later intents need
manual action. SQLite/delivery history grows until repository/stack removal. Backup rollback can restore an
older replay ledger and cannot undo requests. Keep #57 open for final release verification.
