# Issue #54 implementation and review evidence

PR: https://github.com/uniskela/stack-manager/pull/65
Branch: `feat/per-stack-deployment-webhooks`
Base: `3e37b62` (PR #64 merged). No overlapping feature PR was open.

## Scope and implementation

Explicit registered stack → one encrypted deployment webhook binding → deliberate manual confirmation.
No automatic trigger from Git pushes, inbound deliveries, polling or routing rules. No runtime/container
management or health inference. Automatic preference stays false and the UI marks it unavailable.

| Provider | Method/body | Authentication | Acceptance |
| --- | --- | --- | --- |
| Portainer webhook | HTTPS POST, empty body | Complete token-bearing URL encrypted | HTTP 2xx only |
| Generic webhook | HTTPS POST, `{"event":"deployment_requested"}` | Optional encrypted bearer; attempt Idempotency-Key | HTTP 2xx only |

Both reject redirects, invalid TLS, embedded URL credentials and non-HTTPS schemes. Network policy
validates every DNS answer and socket lookup pins a vetted address; original hostname verification is
preserved. Private homelab endpoints require the existing operator opt-in; forbidden hosts/addresses
stay blocked. Connection deadline 5 seconds, total deadline 15 seconds including DNS. Response bodies
are destroyed without reading, and raw provider errors never enter history/logs. No real deployment
webhook was contacted during testing.

Migration `0009_flashy_turbo.sql` follows unchanged `0008`. It adds bindings, attempts, per-stack
uniqueness and active-attempt uniqueness, foreign keys and two managed credential cleanup triggers.
Credential preparation and CAS binding attachment are one immediate transaction. Shared managed
ownership is propagated within the transaction so final removal cleans only unreferenced app-owned
credentials. Externally supplied shared credentials remain operator-managed. Attempt history survives
binding removal; stack/repository deletion cascades it. Existing source, credentials, Git webhook
replay rows, jobs, drafts and stacks remain intact; no bindings are inferred or enabled on upgrade.

Worker execution persists send intent before network I/O. Binding revision, credential nonce, actor
and lease fencing protect execution. A running intent reclaimed after interruption becomes unknown;
known acceptance never causes a resend. Atomic queue/attempt insert and an active-job guard serialize
requests per stack. A new deliberate operator action is required after uncertainty. HTTP acceptance
never means deployment completion, running containers or health.

## BREAKING CHANGE: planned deployment retry contract

The former ADR plan retried an attempt with persisted send intent but no recorded acceptance using
its existing idempotency key. #54 replaces that planned behavior: such an uncertain attempt becomes
**unknown** and is never resent automatically. Known HTTP acceptance is also never resent; an unsent
queued attempt can still make its first request.

This affects integrations built against the earlier deployment-trigger plan for Portainer and generic
webhooks. #54 introduces the first shipped implementation, so existing released deployment consumers
do not need migration. Repository synchronization retries are unchanged.

To adapt an integration or retry safely, inspect the attempt history and the destination's own records
first. If another request is appropriate, use **Deploy now** and confirm it deliberately; this creates
a new attempt. Do not infer failure from a timeout or clear recorded intent to force an automatic resend.
For Portainer, inspect the stack or receiver before retrying because webhook acceptance does not
verify deployment completion or container health.

## Independent review dispositions

- Fixed: DNS failures prevented disabling an unchanged binding. Disabled settings now retain credential
  kind/provider/workspace validation without requiring fresh DNS for the unchanged destination.
- Fixed: sharing a managed credential could orphan it after removing the original owner. Ownership is
  propagated when attaching an already-managed credential; database triggers clean it on last reference.
- Fixed: settings validation could race worker timestamp updates. Save now retains the transaction's
  latest attempt/acceptance/failure timestamps. Accepted/rejected interleaving regressions pass.
- Reviewed: TLS verification, DNS snapshot pinning, no socket reuse/redirects, safe provider failure
  mapping, record-before-send/restart behavior and no #55 behavior.
- Scoped independent re-review at `3f00013`: no remaining important findings; 24 targeted tests pass.
- Real authenticated route → existing worker → local TLS receiver journeys cover both providers,
  concurrent request rejection, safe history, one send and binding removal.

## Maintained validation

- `pnpm install --frozen-lockfile --ignore-scripts` and approved native rebuilds: passed.
- `pnpm check` at `3f00013`: 531/531 tests pass, formatting/lint/typecheck pass.
- Production build: passed. Migration drift: no schema changes.
- Focused provider/network coverage includes private opt-in, blocked metadata/loopback/link-local,
  DNS rebinding, redirect rejection, certificate trust/hostname, handshake/response/DNS timeout and abort.
- SQLite tests cover migration 0008 upgrade, retained data/reopen, independent connections, binding
  CAS/rollback, shared cleanup, deletion, missing/wrong credential, actor disable, stale lease, known
  acceptance crash and unknown recovery. API tests cover auth/CSRF/strict bodies; browser tests cover
  providers, masked rotation, disable/remove, input retention, duplicate submissions and keyboard/axe.
- Rootless Docker build and read-only/cap-drop smoke with a public Git clone passed. Same-volume restart
  preserves setup; missing encryption key is refused; npm/npx/corepack/yarn absent from runtime.
  Only a loopback host port was published; temporary container/volume/env file removed.
- Initial full check found one docs-manifest fixture missing the new slug; corrected and rerun green.
- Full Playwright/axe at `3f00013`: 43 passed, 13 expected skips, including the public sample repository editor tests. Final-head verification follows the validation-review fix below.

## Remote review

Kody review and `@kody -v business-logic` requested on PR #65. CodeQL, Gitleaks, Docker and SonarCloud
initial-head checks pass. Separate container-security workflow dispatched without image publication:
https://github.com/uniskela/stack-manager/actions/runs/39544082520

SonarCloud initial quality gate passes, zero new security hotspots. Readability/complexity advisories
were fixed in `9c3182a` and `ac15087`. SQLite S7503 advisories are intentionally retained: persistence ports are Promise-based
for PostgreSQL portability and async functions turn synchronous SQLite exceptions into rejected Promises.
Removing async changes error behavior; adding dummy await hides the design. No rule is suppressed.
Recovery audit writes remain sequential and bounded to at most one active attempt per stack (S9382).
Recovery persists before auditing; the central AuditService catches and logs redacted write failures,
so audit storage errors do not abort recovery. A batch/concurrency API would add no throughput here.

## Kody business validation

The initial business validator found one missing acceptance criterion: distinct provider test/status.
Added **Validate destination**, which checks the saved configuration and DNS/network policy without
sending any HTTP request. Status/time persist in the existing credential test fields, with binding
revision and credential nonce fencing so concurrent rotation/removal cannot stamp stale results.
The UI preserves unsaved input and explicitly excludes TLS, HTTP acceptance and health verification.
Disabled bindings may be validated. Rotation resets the status. Kody revalidation reports **Compliant**, high confidence, with no missing or partial requirements:
https://github.com/uniskela/stack-manager/pull/65#issuecomment-6314688187

## Remaining operational acceptance

Use a disposable stack with the operator's exact Portainer version/edition, trusted reverse proxy and
CA chain. Confirm private DNS/network policy, real acceptance/rejection behavior, encrypted-backup
restore and receiver-side inspection before retrying an unknown outcome. Disabling cannot recall a
request already sent. Attempt history grows until stack deletion; monitor database size. Restoring a
backup cannot undo remote deployment requests. Keep issue #54 open until merged and verified.

Ruling: the operator's complete task was the approved implementation specification; no separate design
approval pause. If that interpretation was wrong, the cost is reversible branch rework. No merge,
release, image publication or production deployment performed.

## Final review follow-up

- Fixed scoped review P2: validation no longer adopts a changed binding revision while retaining stale
  form values. It reports a reload conflict and preserves the old revision and unsaved inputs. The
  desktop/mobile browser fixture verifies that a later save cannot undo another tab's disable.
- Fixed Sonar semantic-status advice: native output element replaces the explicit status role.
- Kody preflight semantics: DNS/policy/configuration failures before sending are rejected with no HTTP
  status; after a request may have started, failures remain unknown. No automatic retries were added.
- Kody resource cleanup: protected TLS fixture setup and SQLite handles now close on setup/assertion
  failure, including the real API/worker/TLS journey.
- Kody audit-failure and N+1 suggestions declined: recovery updates all matching state transactionally
  before auditing, the active-attempt invariant bounds this to one row per stack, and AuditService
  already catches/logs redacted insert failures. A regression verifies unknown recovery survives audit
  storage failure without sending again. No batching abstraction is needed.
- Kody breaking-change warning clarified in ADR0002: the earlier retry behavior was a plan; #54 adds
  the first deployment-trigger consumers. There is no shipped deployment API to migrate. Repository
  sync retries remain unchanged; operators/integrations must explicitly reconfirm unknown outcomes.
- Final local Docker rebuild was cancelled when the VPS approached disk capacity. Earlier local
  Docker smoke/restart/missing-key checks passed; final-head Docker CI and the separate configuration,
  dependency and image security workflow at run 39590233264 passed without publication.

Latest maintained local check: 544/544 tests and format/lint/types passed. Full browser/axe rerun:
43 passed, 13 expected skips with the public sample repository. One interrupted run failed when a
concurrent rebuild replaced the server assets; the isolated rerun above passed. Final semantic output
layout was visually checked and given block layout to keep status/date/message readable on phones.
Sonar gate remains green, with ten Promise-port S7503 and one bounded recovery S9382 advisory
retained with the dispositions above; no security hotspots. Sonar coverage is not imported by the
maintained workflow, so its 0% display is not a test execution result.

Final focused desktop/mobile deployment+axe run: 4/4 passed, screenshots refreshed with synthetic
configuration only. Final production build and 32 service regressions pass after the small readability
and status-layout changes. All maintained PR checks at b8f661a pass; final documentation/layout head
is rechecked by CI. No merge, release, image publication or production deployment was performed.

Follow-up Kody audit finding: destination validation now records `deployment.destination_validated`
with safe status metadata and success/failure outcome. Configuration updates retain their own action.
Regression coverage checks both validation outcomes, unchanged binding revision, no misleading
binding-update event, and absence of the secret URL in audit records.
