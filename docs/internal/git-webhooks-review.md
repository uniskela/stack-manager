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

## External review / CI follow-up

The initial Gitleaks run flagged the exact synthetic HMAC fixture in the provider unit tests
(`generic-api-key`). The existing default rules remain enabled; an AND-scoped exception matches
only that exact fake value in that exact test file, following the existing redaction-fixture policy.
No real signing credential is committed or exempted.

Initial [Sonar analysis](https://sonarcloud.io/dashboard?id=uniskela_stack-manager&pullRequest=64) passed
its quality gate with zero new security hotspots. Individual dispositions:

| Finding | Disposition |
| --- | --- |
| [WX5x](https://sonarcloud.io/project/issues?id=uniskela_stack-manager&issues=AaFcMi1BOQ3_qzSlWX5x) optional chain | Fixed credential-kind guard. |
| [WX5y](https://sonarcloud.io/project/issues?id=uniskela_stack-manager&issues=AaFcMi1BOQ3_qzSlWX5y) synchronous callback declared async | Fixed: credential callbacks may return a value or Promise; verification uses the synchronous return. |
| [WX5z](https://sonarcloud.io/project/issues?id=uniskela_stack-manager&issues=AaFcMi1BOQ3_qzSlWX5z) nested result ternary | Fixed with explicit duplicate return. |
| [WX53](https://sonarcloud.io/project/issues?id=uniskela_stack-manager&issues=AaFcMi6iOQ3_qzSlWX53) route complexity | Fixed by extracting existing signed/raw and ordinary/schema body readers, preserving validation and error mapping. |
| [WX50](https://sonarcloud.io/project/issues?id=uniskela_stack-manager&issues=AaFcMi41OQ3_qzSlWX50) async SQLite accept | Retained deliberately: implements an async persistence port and turns synchronous database failures into rejected Promises. The transaction callback must remain synchronous; adding a meaningless await would obscure that requirement. |
| [WX51](https://sonarcloud.io/project/issues?id=uniskela_stack-manager&issues=AaFcMi41OQ3_qzSlWX51) optional chain | Fixed transaction connection/credential guards. |
| [WX52](https://sonarcloud.io/project/issues?id=uniskela_stack-manager&issues=AaFcMi41OQ3_qzSlWX52) async SQLite query | Retained deliberately to implement the Promise-based port and map synchronous database failures to rejected Promises, matching the surrounding SQLite repositories. |
| [WX54](https://sonarcloud.io/project/issues?id=uniskela_stack-manager&issues=AaFcMi8KOQ3_qzSlWX54) optional sample test skip | Added adjacent explanation; CI provides the sample remote. |
| [WX55](https://sonarcloud.io/project/issues?id=uniskela_stack-manager&issues=AaFcMi8KOQ3_qzSlWX55) optional sample test skip | Added adjacent explanation; CI executes it. |
| [WX56](https://sonarcloud.io/project/issues?id=uniskela_stack-manager&issues=AaFcMi8KOQ3_qzSlWX56) shared mobile mutation skip | Added adjacent explanation; desktop performs mutations while mobile verifies rendering/accessibility. |

No Sonar suppression or rule change was introduced. The two Promise-port advisories are maintainability
notes, not security findings; their external issue statuses are not changed by this evidence record.

Local Gitleaks v8.30.1 scanned all 148 reachable commits without leaks after the exact fixture exception.
Temporary control repositories verified the exact test value/path is allowed, the same value in a different
path is detected, and a different value in that test file is detected. The default rules remain enabled.

The first follow-up CI scan still flagged the synthetic fixture: the pinned action defaults to Gitleaks
**8.24.3**, which predates `[[allowlists]]` (introduced in 8.25). CI now explicitly selects **8.30.1**,
the locally validated version. This makes the existing narrowly scoped redaction-fixture configuration
and the new exact HMAC fixture exception effective without broadening any path/value exception.
The action SHA, default rules and read-only workflow permissions are unchanged.

Provider version corroboration: Forgejo **v11.0.0** `services/webhook/shared/payloader.go`
(`AddDefaultHeaders`) independently confirms bare hex SHA-256 in `X-Forgejo-Signature` plus native
`X-Forgejo-Event` / `X-Forgejo-Delivery`; Gitea **v1.24.0** `services/webhook/deliver.go` confirms
its distinct native contract. Current official docs and fixtures are linked in the user guide.
