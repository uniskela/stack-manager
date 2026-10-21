# Deployment webhooks

Each explicitly registered stack can have one independent deployment binding. Open the stack’s
**Deployment** tab to configure it. No binding is inferred from folder names. Git pushes, inbound
Git webhooks and scheduled fetches do not trigger deployment. Automatic deployment is unavailable
until the deployment-routing phase; its stored preference defaults to false.

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
**Rejected** means a non-success response or a local validation failure prevented the request.
**Unknown** means the destination may have received it, including a connection failure, timeout,
or worker interruption after intent was recorded. Inspect Portainer or the receiver before choosing
Deploy now again. Stack Manager never blindly retries an ambiguous send or a known acceptance.
An intent recorded immediately before a crash may show unknown even if nothing was sent; this
conservative behavior avoids accidental repeated deployments.

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

## Migration, backups and rollback

Migration `0009` adds deployment binding and deployment attempt tables after `0008`. Existing stack,
Git webhook and credential records remain intact. No existing stack gets a deployment binding.
The database enforces one binding per stack and prevents deletion of referenced credentials. Deleting
an explicit stack cascades its binding and deployment history; it does not delete repository source.

Before upgrading, stop the application and back up the complete data volume, including SQLite/WAL
files as described in [Backup and restore](BACKUP_RESTORE.md). Keep encryption keys securely outside
that backup: restoring encrypted webhook URLs requires the same key material. Test a restore before
relying on it. Migrations run on startup; do not edit previous migrations or apply hand-written down
migrations. To roll back, stop all workers, inspect destinations for any in-flight requests, restore the
pre-upgrade data backup and matching encryption configuration, then run the prior pinned application
version. Restoring a database cannot undo a deployment request already sent to another system.
