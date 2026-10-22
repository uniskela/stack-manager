# Deployment webhooks

Each explicitly registered stack can have one independent deployment binding. Open the stack’s
**Deployment** tab to configure it. No binding is inferred from folder names. Manual deployment is
available independently. Automatic deployment is off by default and requires explicit per-stack
rules and a verified forge push webhook.

## Portainer

In Portainer, enable the stack’s webhook and copy its complete HTTPS webhook URL. Select
**Portainer webhook**, paste the URL into the secure input and save. The standard URL ends in
`/api/stacks/webhooks/<webhook-id>`; a reverse-proxy path prefix and an explicit HTTPS port are
supported. Use the URL supplied by your Portainer instance. Stack Manager sends an empty HTTP
POST and does not need a Portainer API key. The webhook URL grants deployment authority: treat
its path, query and token as a password. Portainer edition and stack type must support webhooks.

## Generic HTTP

Select **Generic webhook**, supply an HTTPS URL and optionally a bearer token. The request is:

```http
POST /your-endpoint HTTP/1.1
Content-Type: application/json
Idempotency-Key: <deployment-attempt-id>
Authorization: Bearer <optional-token>

{"event":"deployment_requested"}
```

The idempotency key identifies the persisted attempt; receivers should deduplicate it if supported.
No custom headers, request templates, scripts or arbitrary payloads are supported. The endpoint
must return a final HTTP response directly. Redirects are rejected without following them.

## HTTPS and private homelab networks

HTTPS with a valid certificate trusted by the Node runtime is required, including behind a reverse
proxy. TLS hostname verification stays enabled. Configure the proxy to accept POST on the final
URL; do not rely on an HTTP-to-HTTPS or login redirect. Install your homelab CA into the runtime’s
trust store when needed; never disable certificate verification.

Private RFC 1918, CGNAT/Tailscale and IPv6 ULA destinations require the server operator to set
`STACK_MANAGER_ALLOW_PRIVATE_NETWORKS=true` and restart Stack Manager. This existing switch
also affects Git remotes, so enable it only for trusted operators and infrastructure. Loopback,
link-local, cloud metadata, multicast and other forbidden addresses remain blocked with the switch
on. A Portainer service on the same host should use a permitted private address or private reverse
proxy, not localhost or a metadata/link-local address. Do not expose the Docker API.

All DNS answers must pass the network policy. The outbound connection uses a validated address,
with the original hostname retained for TLS verification; a second DNS lookup cannot redirect it.
Requests have connection and total deadlines. Response content is discarded and never shown or
logged. A successful HTTP response means the provider accepted the request, not that containers
are running or healthy.

## Validate a saved destination

Choose **Validate destination** to check the saved provider configuration and current DNS/network
policy without sending a webhook. The last validation time and a safe pass/fail message are saved;
disabled bindings can also be validated. This check does not test TLS, connectivity, HTTP acceptance
or container health. Replacing credentials clears their previous validation status. A changed
binding during validation requires a fresh check. A passing check never bypasses execution-time
network policy or enables automatic deployment.

## Manual deployment

1. Review the stack and its saved provider in **Deployment**.
2. Choose **Deploy now**. The confirmation identifies the stack and provider and explains that
   confirming sends a live request to the saved destination.
3. Confirm deliberately. The worker processes the persisted request; a disabled worker leaves it queued.
4. Inspect **Recent deployments** for queued, running, accepted, rejected or unknown outcomes.

Only enabled bindings can trigger. Requests serialize per stack using durable database state;
concurrent submissions cannot create concurrent attempts. Configuration and credential changes
are rechecked before sending. Changing or disabling a queued binding can reject the queued request;
review history and request again deliberately if appropriate. Disabling cannot recall a request that
has already been sent.

**Accepted** means an HTTP 2xx response, not verified deployment success or container health.
**Rejected** means a non-success response, or a local validation/internal failure prevented the request.
A rejection without an HTTP status means no request was sent; inspect its safe reason. Internal
pre-send errors also produce a server log entry without secret details.
**Unknown** means the destination may have received it, including a connection failure, timeout,
or worker interruption after intent was recorded. Inspect Portainer or the receiver before choosing
Deploy now again. Stack Manager never blindly retries an ambiguous send or a known acceptance.
An intent recorded immediately before a crash may show unknown even if nothing was sent; this
conservative behavior avoids accidental repeated deployments.

## Automatic deployment after verified pushes

1. Configure the repository's signed [Git push webhook](GIT_WEBHOOKS.md) and fetch successfully.
2. In the stack's **Deployment** tab, enable the binding and review **Include patterns**,
   **Exclude patterns** and **Dependency patterns** under **Automatic deployment**.
3. Enter repository-relative **Sample changed paths** and choose **Preview routing**. Preview uses
   the unsaved rules and sends no request; it does not check the live baseline or destination.
4. Select **Deploy automatically after verified Git pushes** and choose **Save binding**. This enables
   live future requests for relevant signed pushes. An enabled binding, saved rules, configured signing
   secret and ready synchronized repository baseline are required.

Saving with automation enabled sets the baseline to the current fetched HEAD and tracked branch.
Old history never deploys automatically, and saving again resets the baseline. Fetch and inspect before
saving, particularly after a branch rewrite or blocked history check. Saving does not send a request.

Only verified GitHub, Gitea or Forgejo events for the tracked branch authorize routing. Stack Manager
fetches, then verifies the signed target commit against local Git objects and the fetched HEAD. It
compares committed trees from the binding's baseline to that target, ignoring payload changed-file
lists. Deletes count as changed paths; a rename includes its old and new paths. **Fetch now**, scheduled
polling and an in-app push only fetch; the corresponding signed forge webhook is required for automation.

### Patterns and preview

Enter one pattern per line. Includes are relative to the stack root; dependencies are relative to the
repository root and can select shared files outside the stack. Exclusions win for both: they are checked
against stack-relative root paths and repository-relative dependency paths. Dependencies bypass includes.
An empty include list matches no root paths, including the Compose file. Use `**` explicitly to match
all non-excluded root paths.

The initial form includes standard Compose filenames, the selected Compose file, `config/**` and
`scripts/runtime/**`; it excludes `README.md`, `docs/**` and `**/*.md`. For shared configuration, add
an explicit dependency such as `shared/proxy/**`. Exclude a shared file with its repository-relative path.

Supported wildcards are `*` (within one path segment), `?` (one character) and whole-segment `**`
(zero or more segments). Brace expansion, character classes, negation and extended globs are unsupported,
so patterns cannot contain `{ } [ ] ( ) ! :` even as literal characters. Match such a character with `?`
(for example `config/?prod?/**` for files under `config/(prod)/`). Unicode and spaces in paths are matched exactly.
Paths must be relative POSIX paths without traversal, `.git`, backslashes or control characters.
Each list accepts at most **32 patterns**, each at most **256 characters**. Comparisons accept at most
**1,000 commits** and **10,000 changed paths**, with bounded Git execution, output and wildcard matching work (50 million estimated steps per stack, 100 million per source).
Invalid, missing, rewritten or oversized history blocks the affected routing; it never deploys all stacks.
Inspect the repository, fetch, then save automatic settings deliberately to establish a new baseline.

### Decisions, active requests and unknown outcomes

Open **Recent routing decisions** below Recent deployments for deploy, skip and blocked explanations,
matched paths and commit identifiers. Old or out-of-order targets already included in the baseline skip.
Routine successful evaluations and skips stay out of the dashboard's recent activity feed; failures stay
visible, and the full audit remains in **Settings → Activity**.

One queued or running attempt is allowed per stack. A later matching push during an active attempt is
saved as **blocked**; it is not automatically replayed afterward. Inspect the receiver and active outcome,
then use **Deploy now** deliberately if the later change needs deployment.

An **unknown** outcome places automatic deployment on a persistent hold. Later matching pushes are
blocked. Saving settings, rotating credentials or recreating a binding does not clear the hold. Inspect Portainer or the receiver,
then deliberately confirm a new **Deploy now** request to resume automation. This can send another live
request, so first establish whether the receiver already acted. A new unknown outcome holds automation again.
Known accepted requests are never resent automatically. A crash after request intent may be recorded as
unknown even if nothing was sent; a failure before the routing queue transaction commits leaves no partial
routing decision, attempt or cursor update.

Binding revision, credential version and signing configuration are rechecked before an automatic send.
Disabling or removing a binding stops queued sends when checked, but cannot recall an in-flight request.
Acceptance still means HTTP acceptance, not deployment completion or runtime health.

## Credentials and rotation

The complete URL and optional bearer token are encrypted together using the existing AES-256-GCM
credential store. Only a fixed mask is returned after save. URLs, bearer tokens and ciphertext never
appear in deployment API responses, job payloads, attempt history or audit records. Unsaved inputs
stay only in the secure form controls; they are cleared after a successful save. Do not put real secrets
in screenshots, recordings or browser test fixtures.

Replace the secure configuration in **Deployment** to rotate credentials. Saved values are write-only;
they cannot be revealed or recovered through the interface. Referenced credentials cannot be deleted.
Credentials must belong to the same workspace, have kind `deployment`, and match the selected provider;
inbound Git signing secrets and clone/push PATs are separate. Settings use revision checks, so stale
concurrent saves must reload rather than silently overwrite a newer binding.

## Troubleshooting

- **Queued:** enable the existing background worker and check that it is running. Restart recovery
  preserves the attempt and does not blindly replay a potentially sent request.
- **Unsafe destination:** check DNS and the private-network setting. A DNS name resolving to even one
  forbidden address is rejected. A private-network opt-in never permits metadata or loopback targets.
- **TLS/connectivity:** verify certificate hostname, complete trust chain, port, routing and proxy POST
  handling from the application’s network. Keep certificate checks enabled.
- **HTTP rejection:** inspect the safe status in history, then check the receiver’s own logs. Response
  bodies are intentionally omitted because they can contain credentials or application data.
- **Unknown:** check the receiver before retrying. A failure response does not prove a deployment did
  not start. A new Deploy now confirmation is required for another attempt.
- **Settings changed:** reload the latest settings, review the provider and replace configuration again.
- **No routing decision after a push:** a verified push is routed only after its own fetch succeeds. If that
  fetch fails on every retry (the forge is unreachable for a minute or more), the push is not routed, and a
  later scheduled or manual fetch does not route it either. Nothing is deployed and the binding's baseline does
  not move, so the next verified push includes those changes. Check the fetch error in Overview and use
  **Deploy now** if the change should not wait. Redelivering the same push from the forge does not help:
  an identical body is recognised as a duplicate.
- **Blocked: history unavailable:** the repository was not ready when routing ran, for example because a
  later fetch failed. Fetch, inspect, then use **Deploy now** if the change needs deploying.

## Migration, backups and rollback

Migration `0009` adds deployment binding and deployment attempt tables after `0008`.
Migration `0010_large_salo` then adds routing decisions, saved policy and baseline, persistent automation
hold and internal signed-source metadata. Existing stack, Git webhook and credential records remain
intact. No existing stack gets a binding or automatic deployment enabled.
The database enforces one binding per stack and prevents deletion of referenced credentials. Deleting
an explicit stack cascades its binding and deployment history; it does not delete repository source.

Before upgrading, stop the application and back up the complete data volume, including SQLite/WAL
files as described in [Backup and restore](BACKUP_RESTORE.md). Keep encryption keys securely outside
that backup: restoring encrypted webhook URLs requires the same key material. Test a restore before
relying on it. Migrations run on startup; do not edit previous migrations or apply hand-written down
migrations. To roll back, stop all workers, inspect destinations for any in-flight requests, restore the
pre-upgrade data backup and matching encryption configuration, then run the prior pinned application
version. Restoring a database cannot undo a deployment request already sent to another system. Do not run
the prior version on the migrated database instead of restoring: queued deployment jobs stay dormant there
and can be sent after a later re-upgrade. See [Backup and restore](BACKUP_RESTORE.md#rolling-back-an-upgrade),
including what restoring an older replay ledger means for automation.
