# Authentication and encrypted credential storage

## Authentication (MVP)

- Self-hosted single-operator / small-admin model
- Local user accounts with password hashing (Argon2id or bcrypt)
- Session cookies (HTTP-only, Secure, SameSite) with `STACK_MANAGER_SESSION_SECRET`
- First-run setup creates initial admin (similar pattern to other Uniskela self-hosted apps)
- Optional reverse-proxy auth (header trust) can be a later hardening mode — default off

Out of MVP: full SSO IdP matrix (can add later without changing stack model).

## Provider credentials

### Requirements

Credentials must:

- be **encrypted at rest**
- **never** be sent to the client after initial configuration
- **never** appear in logs
- **never** appear in Git
- be **redacted** from audit events
- support **connection testing server-side**

### Encryption design

- Envelope encryption with a data key per credential **or** direct AEAD with application master key
- Master key from env: `STACK_MANAGER_ENCRYPTION_KEY` (32-byte value, base64)
- Algorithm: AES-256-GCM (or libsodium secretbox) with random nonce
- Store: `ciphertext`, `nonce`, `keyVersion`, `providerType`, non-secret `meta`
- Key rotation: support `keyVersion` re-encrypt job later

### Client API contract

- `POST` create: accepts secret once; response returns id + label + masked hint only
- `PATCH` update secret: replace-only; never echo
- `GET` list/get: **no** secret fields
- `POST` test-connection: server decrypts ephemerally in memory, calls provider, returns status

#### Implementation (PR #2)

**Authentication**

- Passwords: Argon2id (`m=64 MiB, t=3, p=1`), minimum 12 characters, may not contain the username.
  Unknown usernames are verified against a dummy hash to blunt timing-based user enumeration.
- Login and setup-token attempts are rate limited in memory (10 failures / 15 min per username, and per client IP
  when it is known). Forwarding headers are ignored unless `STACK_MANAGER_TRUSTED_PROXY_HOPS` is set; unknown
  clients are never pooled into a shared bucket (setup-token attempts fall back to a global limit).
- Sessions: 256-bit random token in the cookie; the database stores only `HMAC-SHA256(STACK_MANAGER_SESSION_SECRET, token)`,
  so a leaked database or backup cannot be replayed. Sliding expiry (`STACK_MANAGER_SESSION_TTL_HOURS`, default 7 days).
- Cookie: `HttpOnly; SameSite=Lax; Path=/`, plus `Secure` and the `__Host-` name prefix when
  `STACK_MANAGER_COOKIE_SECURE=true` (default in production).
- CSRF: state-changing API requests require an `Origin` (or `Referer`) matching `STACK_MANAGER_PUBLIC_URL`
  (or the `Host` header), and request bodies must be `application/json` and ≤ 64 KiB (enforced from
  `Content-Length` and while streaming).
- First-run setup is atomic and one-shot; optional `STACK_MANAGER_SETUP_TOKEN` gates it.
- Every API route is wrapped by `defineRoute`, which is authenticated by default; only health, setup and
  login/logout are public (enforced by a test).

**Credentials**

- `AES-256-GCM`, 96-bit random nonce per encryption, 128-bit tag. Stored as `secret_ciphertext`, `secret_nonce`,
  `secret_key_version`, plus a masked `secret_hint` and allowlisted non-secret `secret_meta` (e.g. `username`).
- Associated data binds each ciphertext to its workspace and credential id; ciphertext copied to another row fails.
- Decryption failures (wrong key, tampering, unknown key version) raise a generic error and the operation fails.
  Listing still works so the UI can show which credential needs re-entry.
- Plaintext is only available inside `CredentialService.withPlaintext(…)`, used for server-side connection tests and
  Git operations. The HTTP API has no endpoint that returns it.
- Endpoints (all under `/api/workspaces/{workspaceId}`):
  `GET|POST credentials`, `GET|PATCH|DELETE credentials/{id}` (PATCH: label/meta only),
  `PUT credentials/{id}/secret` (replace-only), `POST repositories/test` and `POST repositories/{id}/test`
  (server-side decrypt and connection test).
- PR #2 accepts credentials of kind `git` for registered Git providers; other kinds are enabled as their provider
  registries arrive (PR #5–#7).

## Portainer-specific guidance

Document in UI and security docs:

- API tokens inherit the Portainer user’s permissions
- Recommend dedicated least-privilege integration identity
- Webhook deploy does not require API token
- Runtime provider token should be read-only where Portainer permits

## Git credentials

- PAT or SSH private key encrypted as credential
- Prefer fine-scoped tokens (contents: write for push; webhook separate)

## Backup interaction

Credential ciphertext may be included in application backups. Master key is **not** stored in the DB backup; losing the key loses credential recoverability (document clearly).

## Non-goals

- Client-side encryption that puts key material in the browser
- Sharing plaintext secrets via Docs tab
