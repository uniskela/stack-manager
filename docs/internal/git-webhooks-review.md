# Issue #53 review and validation

Implementation branch: `uniskela/adhd-v0.6.0-signed-git-forge-push-receiver`.
Scope: signed inbound Git push → durable repository fetch. No deployment triggers.

## Design and security

- Native GitHub, Gitea and Forgejo headers only; raw-byte SHA-256 HMAC and timing-safe comparison,
  bounded 1 MiB bodies, POST uncompressed UTF-8 JSON. Parsing follows verification.
- `defineRoute` has an explicit `signed-webhook` mode; route coverage allowlists only the inbound POST.
  Regular public and authenticated mutations retain same-origin checks. Signing configuration requires a
  session and same-origin validation. No session is resolved for signed ingress.
- Separate encrypted `git_webhook` credentials reuse AAD/SecretBox and existing webhookCredentialId.
  Git credential consumers enforce kind/provider before decrypting to prevent signing-key use as a PAT.
- Delivery and existing queue enqueue/coalescing share an immediate SQLite transaction; storage failure
  rolls both back. Pending fetches coalesce; new deliveries during running fetches request a durable rerun.
  Transactional credential nonce/connection checks fence concurrent rotation/disable/config changes.
- No raw bodies/signatures/secrets in delivery rows, queue payloads, responses or audit. Mask is fixed.
  Unauthenticated failures stay outside the delivery ledger; use forge delivery history.
- Native HMAC does not cover delivery headers or timestamps. A captured signed body can be replayed
  with a changed ID; TLS and secret protection remain necessary. Metadata has no automatic retention.

## Validation log

- Baseline: hardened frozen install and approved native rebuild; 413 tests passed.
- Initial focused synthetic fixtures: 60 tests passed, including real Git worker/restart.
- Importing published provider examples exposed a GitHub deletion fixture in the success scenario;
  selected the published non-deletion new-branch example instead. Docs manifest expectations updated.
- Independent review identified signing-key/PAT confusion in existing Git consumers. A new route
  regression test reproduced acceptance before the fix; expected kind/provider now checked before decryption.
- Final validation, screenshots, CI, Kody and Sonar results are appended below as observed.

## Operational acceptance and rollback

Live GitHub/Gitea/Forgejo deliveries against the operator's exact versions remain an installation check.
No homelab access, production deployment, merge, release or image publication is authorized.
Migration `0007_git_webhook_deliveries` is additive. Disable hooks and take a consistent SQLite/WAL backup
with the encryption key before upgrade; restore a compatible pre-upgrade backup before older-version
rollback. Delivery history and encrypted credentials must be included in backup/recovery.

## Local verification results

- Frozen install with `--ignore-scripts`, explicit `better-sqlite3`/`esbuild` rebuild passed; no dependency changes.
- Final `pnpm check`: **478 tests passed**, including all existing Git safety, scheduler and workflow tests.
- Production `pnpm build` passed. Drift generation reported no schema changes.
- Focused provider/security/SQLite/migration coverage: 70 tests passed, including separate SQLite
  connections, in-flight rotation/disable/branch/remote changes, clone credential misuse, real Git and restart.
- Full production Playwright/axe: **41 passed, 13 conditional skips** (mobile-only/desktop-only shared
  scenarios and separate server-disabled policy scenario). The launcher exited 143 during server teardown
  after printing the passing summary; targeted real-HTTP webhook rerun recorded below.
- Rootless Docker production build passed. Read-only/capabilities-dropped runtime bound only to
  `127.0.0.1:32153` passed `scripts/smoke.sh` with a real awesome-compose clone. Same-volume restart
  returned healthy; missing encryption key was rejected. The first immediate post-restart curl saw an
  empty reply before readiness; the readiness/health check passed afterward.
- Production dependency audit: no known vulnerabilities.
- Independent reviewer rechecked both fixes and found no remaining substantive webhook issue.

UI artifacts: [desktop](screenshots/issue-53-desktop.png), [mobile](screenshots/issue-53-mobile.png),
[configured](screenshots/issue-53-configured.png). No secrets appear in these captures.

The enhanced HTTP browser test confirmed 202 acceptance and 200 duplicate handling, then failed at
clipboard copying because the headless browser lacked clipboard permission. The test now grants that
permission explicitly; the production copy action already reports a safe fallback when denied.

Enhanced production HTTP/browser rerun: **5 passed, 1 expected mobile mutation skip**, exit 0.
It verifies real Next.js POST acceptance (202), duplicate acknowledgment (200), invalidation of the old
signature after rotation (401), copy URL, masked settings, confirmation focus and light/dark axe checks.
