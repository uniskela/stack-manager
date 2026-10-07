# Security and threat model

## Assets

| Asset | Sensitivity |
| --- | --- |
| Git forge PATs / SSH keys | Critical |
| Deployment webhook URLs/tokens | High |
| Runtime API tokens (Portainer) | High |
| Secret provider tokens | Critical |
| Session secrets / encryption master key | Critical |
| Repository source (may include non-secret config) | Medium |
| Runtime logs (may leak secrets) | High |
| Audit trail | Medium (must not contain secrets) |

## Trust boundaries

```text
Browser UI  --HTTPS-->  stack-manager  --HTTPS-->  Git forge
                                   |----------->  Deploy webhooks
                                   |----------->  Runtime APIs (RO)
                                   |----------->  Secret APIs
                                   |----file---->  Data volume (SQLite, clones)
```

Assume: operator places stack-manager on a trusted homelab network behind auth and TLS termination; still design for stolen-backup and SSRF cases.

## Threats and controls

| Threat | Control |
| --- | --- |
| Credential theft from DB dump | AEAD encryption; master key separate from backup |
| Credential leakage to browser | API contract omits secrets after save |
| Token in logs | Structured logging redaction middleware; forbid logging Authorization headers / webhook URLs raw |
| Cleartext credential transport | HTTPS with certificate validation required for credential-bearing webhooks, forge APIs, runtime APIs, and secret APIs; HTTPS/SSH for Git remotes; reject plaintext before sending secrets |
| Audit leakage | Redaction policy; URL sanitisation |
| Forge webhook forgery | HMAC/signature verify; ignore unsigned |
| Webhook replay | Idempotency keys |
| SSRF via webhook URL config | Validate URL scheme; deny localhost/metadata by default with documented RFC1918 allow option for homelab |
| Malicious Compose aiming at host | No Docker socket; no exec; deploy happens in external system |
| Privilege escalation via Portainer token | Document least privilege; app allowlists read-only API calls |
| Supply chain | Lockfiles; minimal deps; container non-root where practical |
| CSRF | SameSite sessions + origin checks on mutating routes |
| XSS in log viewer | Treat logs as untrusted text; strict encoding |
| Path traversal in git file APIs | Repo paths normalised and scoped to the stack folder; `..`, `.git` and control characters rejected; content read from Git objects (symlinks are listed, never followed) |
| Secret files in repositories | `.env*` (except templates), keys/keystores and `secrets/` paths are shown as locked; contents are never returned to the browser or stored as drafts |
| XSS via repository Markdown | Rendered without raw HTML; unsafe URLs dropped; relative links mapped to stack routes; only https images, no referrer |

## Explicit non-features (security-relevant)

- No arbitrary Docker exec
- No destructive runtime mutations through RuntimeProvider
- No storing secret values from Infisical into Git

## Security review checklist (later PRs)

- [x] Encryption key required at boot (PR #2 — process exits on missing/malformed key)
- [x] Secret redaction tests (PR #2 — logger, audit, job payloads, API responses, data dir scan)
- [ ] Webhook signature tests
- [x] SSRF unit tests (PR #2 — Git remote host policy; deploy webhook URLs in PR #5)
- [ ] Log viewer XSS tests
- [x] Dependency vulnerability scanning in CI (PR #2 — `pnpm audit --prod`; Trivy on `pnpm-lock.yaml`)
- [x] Secret scanning of the full Git history on every PR, push and nightly (gitleaks, `.gitleaks.toml`)
- [x] Container image scanning: Trivy gate on fixable HIGH/CRITICAL for PRs touching the image, weekly, and before
      every release publish; Dockerfile misconfiguration scan; runtime image ships without npm/npx/corepack/yarn
- [x] Pinned GitHub Actions (commit SHAs) with Dependabot updates; release images carry SBOM + provenance

## Controls implemented in PR #2

- **Git invocation:** `git` is spawned with an argv array (no shell), `--` before URLs, validated branch names
  (no leading `-`), a protocol allowlist (`https` only), hooks disabled, no system/global config, an isolated
  `HOME`, no credential helpers or prompts, and redirects not followed (auth headers are never replayed to
  another host). Tokens travel as an `http.extraHeader` via `GIT_CONFIG_*` environment variables — never in
  argv, remote URLs or `.git/config` — and are scrubbed from stdout and stderr before either can become an error.
  Mutation operations disable signing, filesystem-monitor commands and automatic maintenance. Selected contents are hashed without clean filters; hooks never run.
- **Git mutation:** detached temporary worktrees have isolated indexes and no checkout. Canonical selected paths are verified against Git objects; symlinks, submodules, secrets and file/directory collisions are refused.
  Expected local/remote heads, base blobs and ancestry are checked under a repository lock. Push uses an exact SHA-to-branch refspec with no force or mirror option. Cancellation does not cancel cleanup; provider operations never delete drafts.
- **Remote URL policy:** HTTPS only; embedded credentials, query strings and traversal segments are rejected.
  Resolved addresses must not be loopback, link-local/metadata or multicast — including IPv4 embedded in IPv6
  (mapped, compatible, translated and NAT64 forms, dotted or hex); private ranges require
  `STACK_MANAGER_ALLOW_PRIVATE_NETWORKS=true`. Known gap: the address is checked before `git` resolves the host
  itself (DNS rebinding / TOCTOU); pinning the resolved address (`http.curloptResolve`) is a planned follow-up.
  Mitigations today: HTTPS only, redirects not followed, private networks denied by default.
- **Paths:** clone directories are derived from server-generated ids and resolved with containment checks
  (including symlinks) under `<data dir>/repos`.
- **Headers:** `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`,
  COOP and a CSP limited to `frame-ancestors`/`base-uri`/`form-action`/`object-src` (script nonces: PR #8).
- **Container:** non-root, read-only root filesystem, all capabilities dropped, `no-new-privileges`, no Docker socket.

## Incident expectations

If a Portainer token with excess privileges is configured, the **application** must still refuse to expose destructive actions. Compromised tokens remain a Portainer-side risk — document rotation steps.
