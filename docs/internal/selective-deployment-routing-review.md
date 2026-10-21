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
- Final `pnpm check`: format/lint/typecheck and 655 tests passed, including branch fencing and Unicode ordering.
- Targeted Git/workflow/jobs/SQLite routing regressions: 79 passed.
- Migration generation reports no schema changes after migration 0010.
- Production build and full Playwright/axe run against the public sample repository passed: 43 passed,
  13 intentional skips (duplicate viewport/shared mutations and separate worker-disabled/server scenarios).
  [Desktop screenshot](screenshots/issue-55-desktop.png) and [mobile screenshot](screenshots/issue-55-mobile.png).
- [CI on correction commit `36bd40e`](https://github.com/uniskela/stack-manager/actions/runs/39618777802)
  passed tests, migration drift, build, production smoke, full browser suite, workflow lint and dependency audit.
  CodeQL Actions/TypeScript and Gitleaks passed; external CodeQL reported no new alerts.
- [Container security on `36bd40e`](https://github.com/uniskela/stack-manager/actions/runs/39618798707)
  passed configuration, production dependency and image gates, including the package-manager removal check.
- Rootless Docker is configured. Low host disk space prevents a fresh local image build. CI now runs the
  production smoke script, restarts the container and verifies persisted workspace data and routing migration.
  Initial restart reached healthy; its assertion used a package name unavailable
  from the traced standalone root. The assertion now uses Node 24's built-in read-only SQLite reader.
  Corrected remote execution passed, confirming workspace persistence and the routing schema after restart.
  Local assertion self-check and workflow shellcheck also passed; no host/network security settings were changed.

## External review dispositions

[Kody business validation](https://github.com/uniskela/stack-manager/pull/66#issuecomment-6318713869)
reports **Compliant**, high confidence, with no missing acceptance criteria. Final independent read-only
review through `bee03c3` found no critical/important defects. Inline Kody findings, if any, remain pending.

Initial [Sonar analysis](https://sonarcloud.io/dashboard?id=uniskela_stack-manager&pullRequest=66)
reported 35 findings and zero security hotspots. Each rule group was reviewed:

| Findings | Disposition |
| --- | --- |
| S2871 (2), implicit path ordering | Fixed with explicit ordinal comparators; locale-independent ordering is intentional for exact Git paths. Added case/Unicode order regression. |
| S6535 (1), redundant escape | Fixed by explicit absolute-path check. |
| S7723 (4), Array constructor style | Fixed. |
| S7722 (1), missing internal error message | Fixed; public error remains safely generic. |
| S3358 (1), nested label ternary | Fixed with typed label mapping. |
| S5906 (1), assertion reporting | Fixed with length matcher. |
| S9382 (13), awaits inside routing loops | Retained deliberately: sources advance per-binding cursors in order, reads depend on preceding recovery, and matching work has a shared source budget. Parallel execution would invalidate these ordering/resource guarantees. |
| S7503 (7), synchronous SQLite implementations of async ports | Retained deliberately: Promise ports map synchronous failures to rejections, while transaction callbacks must remain synchronous. No meaningless await added. |
| S3776 (5), complexity | Label mapping simplifies the UI render. Remaining orchestration/configuration/transaction/submit advisories are retained: the guarded safety transitions are kept together with integration coverage; no transaction split or behavior change solely to meet a threshold. |

Corrected-head Sonar quality gate passed: reliability/security/maintainability A, zero security hotspots,
ten fixed findings and 25 reviewed advisories remaining (13 ordered awaits, seven Promise ports and five
complexity findings). No suppression, quality-profile change or accepted-issue mutation was introduced.
Sonar reports 0% coverage because the maintained pipeline does not import a coverage report; the 655
passing tests are separate execution evidence. Latest maintained CI/security and Kody results are tracked
on [PR #66](https://github.com/uniskela/stack-manager/pull/66).

## Operator acceptance and residual risk


No production webhook, release, image publication or production deployment is authorized/performed. Before
production opt-in, verify a disposable GitHub/Gitea/Forgejo → receiver path, exact Portainer edition/version,
reverse proxy/TLS/private-network policy, receiver inspection after unknown outcomes and a consistent backup
restore. HTTP acceptance is not container health. Rule/history limits fail closed. Blocked later intents need
manual action. SQLite/delivery history grows until repository/stack removal. Backup rollback can restore an
older replay ledger and cannot undo requests. Keep #57 open for final release verification.
