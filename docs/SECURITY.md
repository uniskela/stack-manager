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
| Audit leakage | Redaction policy; URL sanitisation |
| Forge webhook forgery | HMAC/signature verify; ignore unsigned |
| Webhook replay | Idempotency keys |
| SSRF via webhook URL config | Validate URL scheme; deny localhost/metadata by default with documented RFC1918 allow option for homelab |
| Malicious Compose aiming at host | No Docker socket; no exec; deploy happens in external system |
| Privilege escalation via Portainer token | Document least privilege; app allowlists read-only API calls |
| Supply chain | Lockfiles; minimal deps; container non-root where practical |
| CSRF | SameSite sessions + origin checks on mutating routes |
| XSS in log viewer | Treat logs as untrusted text; strict encoding |
| Path traversal in git file APIs | Resolve under clone root; reject `..` |

## Explicit non-features (security-relevant)

- No arbitrary Docker exec
- No destructive runtime mutations through RuntimeProvider
- No storing secret values from Infisical into Git

## Security review checklist (later PRs)

- [ ] Encryption key required at boot
- [ ] Secret redaction tests
- [ ] Webhook signature tests
- [ ] SSRF unit tests
- [ ] Log viewer XSS tests
- [ ] Dependency vulnerability scanning in CI

## Incident expectations

If a Portainer token with excess privileges is configured, the **application** must still refuse to expose destructive actions. Compromised tokens remain a Portainer-side risk — document rotation steps.
