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
Recovery audit writes remain sequential so audit errors stop the operation predictably; this path is bounded
by the per-stack active-attempt invariant and is not a throughput loop (S9382).

## Kody business validation

The initial business validator found one missing acceptance criterion: distinct provider test/status.
Added **Validate destination**, which checks the saved configuration and DNS/network policy without
sending any HTTP request. Status/time persist in the existing credential test fields, with binding
revision and credential nonce fencing so concurrent rotation/removal cannot stamp stale results.
The UI preserves unsaved input and explicitly excludes TLS, HTTP acceptance and health verification.
Disabled bindings may be validated. Rotation resets the status. Final revalidation is requested after push.

## Remaining operational acceptance

Use a disposable stack with the operator's exact Portainer version/edition, trusted reverse proxy and
CA chain. Confirm private DNS/network policy, real acceptance/rejection behavior, encrypted-backup
restore and receiver-side inspection before retrying an unknown outcome. Disabling cannot recall a
request already sent. Attempt history grows until stack deletion; monitor database size. Restoring a
backup cannot undo remote deployment requests. Keep issue #54 open until merged and verified.

Ruling: the operator's complete task was the approved implementation specification; no separate design
approval pause. If that interpretation was wrong, the cost is reversible branch rework. No merge,
release, image publication or production deployment performed.
