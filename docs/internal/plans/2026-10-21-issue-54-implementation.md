# Per-stack deployment webhooks implementation plan

Goal: implement issue #54 as specified by the operator, with no automatic deployment.
Spec: GitHub issue #54 and the full Codex Task supplied in this session.
Architecture: existing application ports, SQLite repositories, CredentialService/SecretBox, JobQueue/JobWorker and defineRoute. Explicit one-to-one stack binding; encrypted complete configuration; fenced durable attempts. HTTPS POST providers pin validated DNS results without redirects or relaxed TLS.

## Global constraints
- No automatic trigger, runtime control, production deployment, merge or release.
- No secret URL, auth, ciphertext or provider error content in browser responses/logs/audit/jobs.
- Preserve existing migrations; generate migration 0009.
- Private networks require the existing operator opt-in; forbidden addresses always blocked.

## Tasks
1. Provider transport: implement provider interface, Portainer and generic HTTPS POST, secure pinned DNS, TLS, redirects, bounded connection/total timeouts and response disposal. Unit and local mock integration security tests.
2. Persistence and application: domain, ports, schema/migration, atomic credential binding CAS and trigger enqueue, durable serialization, conservative restart outcomes, audit and container integration. Integration/migration tests.
3. HTTP/UI: authenticated scoped routes, strict schemas, stack Deployment tab with masked settings, rotation, enable/disable, accessible confirmation and recent attempt polling. Browser/axe tests and public docs.
4. Integration and review: run frozen install/rebuild, check/build/e2e, migration drift, rootless Docker smoke/restart/security where available. Open PR, request Kody review/business validation, review CI/Sonar findings, address valid findings and update issues #54/#51. Never merge.

## Review focus
- Concurrent configuration changes cannot orphan new credentials or replace a newer binding.
- Lease loss/restart cannot resend a request that may have been sent.
- Disabling/removing/rotating before execution cannot silently deploy a stale destination.
- DNS rebinding cannot change the connected destination; invalid TLS stays invalid.
- Browser errors preserve unsaved input without saving secrets to browser storage or traces.
