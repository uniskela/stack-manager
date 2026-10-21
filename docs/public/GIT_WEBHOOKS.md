# Git push webhooks

Repository **Overview → Git webhooks** accelerates Git fetching after external pushes.
It updates source state only: it does **not deploy stacks or verify container health**.
Scheduled polling and manual fetching remain available independently.

## Configure a repository

1. Set `STACK_MANAGER_PUBLIC_URL` to the externally reachable HTTPS origin. Copy the repository-specific
   destination in **Git webhooks**: `https://your-app.example/api/webhooks/git/<workspaceId>/<repositoryId>`.
   Without the setting, Copy uses your browser's origin; verify that the forge can reach that address.
2. Generate an independent random signing secret with a password manager (at least 32 characters;
   at least 12 distinct characters). Do not reuse a Git access token. Save it in Stack Manager's
   **Signing secret** field and enter the same value in the forge's webhook Secret field.
3. Configure the provider below. Use **POST**, **application/json**, UTF-8, no body compression,
   and push events only. Enable/activate the hook. Form-encoded payloads and GET delivery are unsupported.
4. Push to the connection's tracked branch and check the forge delivery history, then the repository's
   **Last accepted delivery** and fetch timestamps. Acceptance means durable queueing; the worker
   must be enabled for the fetch to execute. Existing retry and Git safety rules still apply.

The endpoint contains only IDs, never a signing secret or Git token. Knowing its URL does not grant access.
Secrets are encrypted using the existing credential master key and record-specific associated data;
only a masked configured indicator is returned. An authenticated administrator configures each workspace.
The optional authenticated settings API accepts an existing `git_webhook` credential ID instead of a new
secret; it must belong to the same workspace and provider. Clone/push credentials remain separate.

## Provider settings and signatures

| Forge | Where to configure | Event / delivery headers | Signature |
| --- | --- | --- | --- |
| GitHub | Repository Settings → Webhooks → Add webhook; content type application/json; Just the push event | `X-GitHub-Event`, `X-GitHub-Delivery` | `X-Hub-Signature-256: sha256=<64 lowercase hex>` |
| Gitea | Repository Settings → Webhooks → Add webhook → Gitea; POST; application/json; Push events | `X-Gitea-Event`, `X-Gitea-Delivery` | `X-Gitea-Signature: <64 lowercase hex>` |
| Forgejo | Repository Settings → Webhooks → Add webhook → Forgejo; POST; application/json; Push events | `X-Forgejo-Event`, `X-Forgejo-Delivery` | `X-Forgejo-Signature: <64 lowercase hex>` |

Use each forge's native hook type. Compatibility headers do not substitute for native headers.
All three verify HMAC-SHA256 over the unchanged request bytes with a constant-time comparison before
JSON parsing. SHA-1, absent/empty signatures, alternate encodings and unsupported formats fail closed.
The contract follows GitHub's current documentation, Gitea's documented native SHA-256 contract
(including 1.24), and Forgejo's current documented native contract (also confirmed in 11.0.0). Older Forgejo installations that
lack `X-Forgejo-*` headers must be upgraded; there is no Gitea-header fallback.
Provider-format fixtures and adapter tests validate these contracts; a live delivery from the
operator's exact forge version remains an installation check.

Repository identity is compared with the **stored HTTPS clone URL**, including host and repository path
(a trailing `.git` is optional). Configure the clone URL used by the forge; alternate host aliases and
renamed/moved repositories require updating/reconnecting the connection. Only
`refs/heads/<tracked branch>` is fetched. Other branches, tags, branch deletions and unsupported events
are ignored. Webhook changed-file lists are never used to route deployments.

Official references:

- [GitHub signature validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)
- [Gitea webhooks](https://docs.gitea.com/usage/repository/webhooks)
- [Forgejo webhooks](https://forgejo.org/docs/latest/user/repository/webhooks/)

## Network and reverse proxy

Use HTTPS with a valid certificate; keep TLS verification enabled in the forge. Keep the application
bound to loopback/private networking and publish through your existing trusted reverse proxy. For
self-hosted forges, prefer a private route/VPN reachable by the forge. GitHub-hosted deliveries need
an HTTPS route reachable from GitHub; exposing only the exact webhook POST path at the proxy can
keep the browser UI private. Do not expose the Docker API or change host firewall policy to test hooks.

Forward the full endpoint path, native event/delivery/signature headers and body unchanged. Do not
parse/re-encode JSON, trim whitespace, rewrite Unicode, decompress/recompress, or redirect webhook
requests. Permit POST JSON bodies up to **1 MiB**; the app enforces this limit while streaming as well
as against Content-Length. Apply proxy connection/time limits and rate limits suited to your installation.
Session authentication redirects and browser CSRF middleware must not intercept this exact path.
Regular Stack Manager mutations still require a browser session and same-origin validation.

## Responses and troubleshooting

| HTTP result | Meaning and action |
| --- | --- |
| 202 `accepted` | Signature/identity/ref verified; delivery and fetch request committed together. Check worker/fetch status. |
| 200 `duplicate` | Delivery already recorded; no new work. |
| 200 `ignored` | Valid signature but unsupported event, repository/ref mismatch, tag or deleted branch. Check forge and tracked branch configuration. |
| 401 | Missing/unlinked/wrong signing credential, wrong provider header or signature. Compare secrets and native hook type; check proxy byte/header preservation. |
| 400 | Signed invalid JSON, push shape, event metadata or delivery identifier. Delivery IDs must be 1–128 ASCII letters, digits, hyphens or underscores. |
| 405 / 413 / 415 | Wrong method / too large / wrong content type, encoding or charset. |
| 500 | Storage or internal failure; acceptance is not acknowledged. Retry/redeliver after recovery. |

Last accepted time appears in Overview. Failed unauthenticated deliveries are not stored as delivery
records or reflected in the UI: inspect the forge's HTTP delivery history. Fetch failures appear in
Overview and Settings → Activity. Never paste signing secrets or raw webhook bodies into support logs.

Delivery IDs are persisted uniquely per repository/provider across process restarts. Recording an
accepted delivery and inserting/coalescing its fetch are one SQLite transaction; a queue error rolls
both back. An already pending fetch is reused. A new delivery during a running fetch durably requests
one follow-up, preserving existing locks, recovery and retries. Duplicate IDs never request a follow-up.
Distinct pushes can coalesce into one fetch, which reads authoritative Git history. No deployment jobs
are created. Ignored verified deliveries are recorded for troubleshooting and deduplicated too.

Native provider signatures cover the body, not delivery/event headers, and have no freshness timestamp.
Protect transport and signing secrets: a party holding a signed body may change delivery headers.
Delivery-ID replay protection does not authenticate a timestamp or prevent a replay with a changed ID.
Delivery metadata is retained until repository removal; monitor database size for busy repositories.

## Rotate or disable

Enter a new independently generated secret, choose **Rotate signing secret…**, and confirm. The old
secret stops working immediately, including verification in progress. Update the forge to the new
secret and redeliver any rejected pushes. There is no grace period. **Disable webhook…** unlinks the
credential and rejects future deliveries immediately; disable/remove the hook in the forge too.
Already queued fetches continue. Unlinked credentials remain encrypted and can be deleted from the
credential API; linked credentials are protected against deletion. Re-enabling requires saving or
selecting a signing credential again. Polling continues according to its independent settings.

## Migration, backup and rollback

The additive migration creates `git_webhook_deliveries` with repository/provider/delivery uniqueness,
received timestamp, event, ref, accepted/ignored status and optional job reference. It stores no raw
payload or secret. Existing repositories start with webhooks disabled; Git history, drafts and jobs are
unchanged. The new credential kind uses the existing encrypted credential table.

Back up SQLite consistently with its WAL and retain the existing encryption key securely; see
[Backup and restore](BACKUP_RESTORE.md). Restoring an older backup also restores its earlier delivery
history, so later redeliveries can fetch again. Do not delete delivery history to troubleshoot retries.
Before rolling back to a version without this feature, disable forge hooks and restore a compatible
pre-upgrade backup with its key. Do not drop tables or edit migrations on a running database. No
production deployment or live forge setup is performed by installing the source changes alone.
