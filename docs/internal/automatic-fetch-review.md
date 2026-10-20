# Automatic fetch review — PR #59

Tracking: [#52](https://github.com/uniskela/stack-manager/issues/52), under [#51](https://github.com/uniskela/stack-manager/issues/51).

## Durable post-push refresh

A running sync may release its Git lock before the handler/job completes. A later push must not deduplicate against that old fetch. Post-push enqueue requests now atomically set `followUpRequested` on a running job. Fenced successful completion atomically returns that same row to pending instead of succeeding. Repeated requests coalesce; the active-key unique index still permits only one job per repository. Claim clears the flag because the next fetch covers earlier requests. Pending jobs, retry backoff, expired-lease reclaim and restart retain the existing at-least-once semantics. This option is for idempotent handlers only; deployment jobs do not opt in.

The worker remains single concurrency. Fetch/commit/push continue using the existing filesystem repository lock. No new queues, lock stealing, ref resets, merges, draft deletion or deployment behavior.

## Timing and visibility

Repository state now persists `lastSyncAttemptAt`, `lastSyncFailedAt` and `lastHeadChangedAt`, alongside successful `lastFetchedAt`. Due time uses the latest attempt/failure/success, never generic `updatedAt`. Existing repositories migrate with null timestamps and use their last fetch/creation as fallback. Overdue interrupted statuses can enqueue again; active jobs still deduplicate in SQLite. Worker retries retain their existing exponential backoff (5 seconds, doubling, capped at 15 minutes); scheduler retries after terminal failure wait the configured interval. Repository overview/API expose these timestamps separately, existing current status and safe failure message remain visible.

A host/process crash during Git work may leave a filesystem lock; the existing fail-closed operator recovery in [Git workflow](../public/GIT_WORKFLOW.md) remains necessary. This PR recovers queue leases and pending work, and does not introduce unsafe timeout-based lock stealing. Queue/storage failures after a successful push are logged; Git and SQLite cannot form an atomic transaction, and the fallback scheduler/manual fetch remains available.

## Batching decision

Retain per-repository enqueue. This is local synchronous SQLite in WAL mode, with an indexed active dedupe key and one small transaction per due repository, not a network database round trip. Scan cadence is one minute; default fetch eligibility is fifteen minutes. The application targets a single self-hosted instance; actual operators' repository counts are unknown and no production data was accessed.

A temporary benchmark on a fresh migrated database using the real JobQueue/repository measured 100 durable enqueues in 184.5 ms and 1,000 in 1,304.5 ms. These are local observations, not capacity guarantees. They do not justify batch-port infrastructure or a shared all-or-nothing transaction that compromises failure isolation. Revisit if measured scheduling latency approaches the minute tick or a network database backend is introduced.

## Per-repository policy decision

Defer repository-specific enable/interval API and settings to an immediately following PR tracked in [#60](https://github.com/uniskela/stack-manager/issues/60), under #52. Global enabled/interval settings remain the policy in this PR; worker-disabled disables automatic scheduling. The follow-up must add safe migration defaults, bounded validation, settings UI/API and policy tests before #52 is considered fully complete. Dashboard work stays in #56. This avoids mixing a settings feature into race/recovery remediation; dedicated retry timestamps and focused status visibility are included here because they are required for correctness.

## Verification

Deterministic integration coverage includes post-fetch/pre-completion push, coalesced follow-up requests, overlapping manual/scheduled requests, simultaneous ticks, lock contention/backoff, pending/running restart, preserved drafts and retained commits, separate success/failure/change timestamps, disabled worker/scheduler boot and lease-owner fencing. Workspace tests cover a failed lookup and a failed enqueue with later work still scheduled.

Observed on `1848cb5`: [CI run 39407389233](https://github.com/uniskela/stack-manager/actions/runs/39407389233)
passed format, lint, types, all 377 tests, migration drift, production build, smoke, Playwright/axe and dependency
audit. CodeQL, Gitleaks, Sonar analysis/quality gate and Kody code review also passed. Local Playwright ran with
awesome-compose/nginx-golang: 33 passed, 9 intentional platform-specific skips. See the [validation comment](https://github.com/uniskela/stack-manager/pull/59#issuecomment-6288756991)
for local check/build and production-container smoke/restart/disabled-worker evidence.

A controlled rootless Docker run passed 61 tests across the Git workflow (including concurrency, retained refs,
drafts and interrupted fetch), queue/fencing, disabled boot and scheduler suites. Reproduce from the PR checkout:

```sh
docker build --target build -t stack-manager:sync-tests .
docker run --rm --mount "type=bind,src=$PWD/tests,dst=/app/tests,readonly" \
  stack-manager:sync-tests sh -c 'apt-get update -qq && apt-get install -y --no-install-recommends git >/dev/null && pnpm exec vitest run tests/integration/git-workflow.test.ts tests/integration/jobs.test.ts tests/integration/boot.test.ts tests/unit/repository-auto-fetch.test.ts'
```

The test tree is mounted because `.dockerignore` excludes it from application images. This temporary build-stage
container adds Git for the local smart-HTTP test server; no ports, production credentials or deployment endpoints
are used. Release publishing was not executed. For later heads, consult [current PR checks](https://github.com/uniskela/stack-manager/pull/59/checks).
