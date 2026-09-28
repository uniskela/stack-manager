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

### Portainer-specific guidance

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
