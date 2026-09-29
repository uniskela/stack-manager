# Domain / data model

Logical model for stack-manager. Physical tables will use Drizzle migrations in PR #2+. Names are indicative.

## Aggregate overview

```text
Workspace
  └─ GitRepositoryConnection
       └─ Stack[]
            ├─ StackSource (root, compose file, docs globs)
            ├─ DeploymentBinding[]
            ├─ RuntimeBinding[]
            ├─ SecretBinding[]?
            └─ DeploymentPolicy (include/exclude/deps)

ProviderCredential (encrypted)
Job / JobAttempt
DeploymentEvent
DeploymentWatch
AuditEvent
User / Session
```

## Core entities

### Workspace

Top-level app instance context (single-tenant self-host MVP may have one workspace).

| Field | Notes |
| --- | --- |
| id | UUID |
| name | Display name |
| createdAt | |

### GitRepositoryConnection

| Field | Notes |
| --- | --- |
| id | |
| workspaceId | |
| gitProviderType | `github` \| `gitea` \| `forgejo` \| `gitlab` (extensible) |
| remoteUrl | |
| defaultBranch | |
| credentialId | Optional clone/push credential; public clone may omit |
| webhookCredentialId | Encrypted webhook-signing secret (`ProviderCredential`); **separate** from clone credential. GitProvider decrypts it only to compute HMAC verification — never return to clients |
| localClonePath | Under data dir; never commit |
| lastFetchedAt | |

### Stack

Explicit unit of source + optional deploy/runtime/secret bindings.

| Field | Notes |
| --- | --- |
| id | |
| repositoryId | |
| name | e.g. Wiki |
| slug | Stable key |
| rootPath | Repo-relative directory |
| composePath | Relative to root or repo |
| docsPaths | Optional globs |
| enabled | |

**Invariant:** stack identity is this record, not a folder name heuristic.

### DeploymentBinding

| Field | Notes |
| --- | --- |
| id | |
| stackId | |
| providerType | e.g. `portainer-webhook`, `generic-webhook` |
| credentialId | Optional (generic auth header ref) |
| config | Provider-specific JSON (URL, method, timeout, metadata) |
| enabled | |

### RuntimeBinding

| Field | Notes |
| --- | --- |
| id | |
| stackId | |
| providerType | e.g. `portainer-api` |
| credentialId | Required for authenticated APIs |
| config | Environment id, stack name/id, deep-link base, etc. |
| enabled | |

Independent from deployment bindings.

### SecretBinding

| Field | Notes |
| --- | --- |
| id | |
| stackId | |
| providerType | e.g. `infisical`, `vault` |
| credentialId | |
| config | project, environment, path |
| enabled | |

### DeploymentPolicy

Stored on stack (or 1:1 child):

```yaml
include:
  - docker-compose.yml
  - compose.yaml
  - config/**
  - scripts/runtime/**
exclude:
  - README.md
  - docs/**
  - "*.md"
dependencies:
  - shared/proxy/**
  - shared/env/**
  - common/compose/**
```

Paths are repo-relative. Dependency paths may mark **multiple** stacks affected.

### ProviderCredential

| Field | Notes |
| --- | --- |
| id | |
| workspaceId | |
| kind | git / deployment / runtime / secret |
| providerType | |
| label | User-visible name |
| secretCiphertext | Encrypted blob |
| secretMeta | Non-secret fields only (host, username hint) |
| lastTestedAt | |
| lastTestStatus | |

**Never** store plaintext. **Never** return ciphertext or plaintext to clients after create/update (return meta + masked status only).

### Job

Persisted background work (webhook processing, watch polling).

| Field | Notes |
| --- | --- |
| id | Stable id; also used as deploy idempotency key material |
| type | `git_webhook` \| `deployment_trigger` \| `deployment_watch` \| … |
| payload | Redacted JSON |
| status | `pending` \| `running` \| `succeeded` \| `failed` \| `dead` |
| runAfter | |
| attempts | |
| lastError | Sanitised |
| leaseOwner | Worker instance id holding the lease (nullable) |
| leaseExpiresAt | When a `running` lease is considered stale and reclaimable |
| heartbeatAt | Last successful heartbeat while `running` |
| acceptanceRecordedAt | For `deployment_trigger`: set once provider acceptance is known so crash recovery does not blind-retry |

Lease recovery rules are defined in [ADR 0002](../adr/0002-persisted-jobs.md).

### DeploymentEvent

| Field | Notes |
| --- | --- |
| id | |
| stackId | |
| source | `ui` \| `webhook_router` |
| gitSha | |
| decision | Routing explanation text/structure |
| providerType | |
| triggerStatus | HTTP acceptance etc. |
| watchId | Optional |

### DeploymentWatch

| Field | Notes |
| --- | --- |
| id | |
| stackId | |
| deploymentEventId | |
| preSnapshot | Runtime snapshot JSON |
| timeline | Ordered events |
| status | `running` \| `healthy` \| `failed` \| `timed_out` |
| postSnapshot | |

### AuditEvent

| Field | Notes |
| --- | --- |
| id | |
| actorUserId | |
| action | |
| entityType / entityId | |
| meta | **Redacted** — no secrets, tokens, webhook URLs with embedded creds |

### User / Session

Minimal self-hosted auth for MVP (local user). SSO can be a later provider. Session secret via env.

## Physical schema notes (PR #2)

Implemented in `src/server/persistence/schema.ts` with migrations in `drizzle/`. Ids are UUID strings, timestamps
are integer epoch milliseconds set by the application clock and JSON is stored as text, keeping a PostgreSQL port
straightforward. Additions beyond the logical model above:

| Entity | Added fields | Why |
| --- | --- | --- |
| User | `role` (`admin`), `lastLoginAt`, `disabledAt` | Extensible local auth |
| Session | `id` = HMAC digest of the cookie token, `expiresAt`, `lastSeenAt`, `userAgent` | Tokens never stored raw |
| Workspace | `slug`, `updatedAt` | Stable addressing |
| GitRepositoryConnection | `name`, `syncStatus`, `lastSyncError`, `headSha`; `localClonePath` is relative to the data dir | Sync state for the UI; data dir can move |
| ProviderCredential | `secretCiphertext`, `secretNonce`, `secretKeyVersion`, `secretHint`, `lastTestMessage`, `createdByUserId` | AEAD storage and masked display |
| Job | `maxAttempts`, `dedupeKey`, `finishedAt`, `createdAt`/`updatedAt` | Retry policy, idempotent enqueue |
| AuditEvent | `createdAt`, `workspaceId`, `outcome` | Filtering and failure tracking |

`JobAttempt` is not a separate table yet; `attempts` and `lastError` on `Job` cover PR #2 needs.

## Working tree / drafts

**Decided in PR #3:** edits are stored as database drafts, not in a Git working tree.

| Entity | Fields | Notes |
| --- | --- | --- |
| Stack (`stacks`) | `repositoryId`, `name`, `slug`, `rootPath`, `composePath` | Unique per repository by `rootPath` and `slug`; `rootPath = ''` is the repository root |
| SourceDraft (`source_drafts`) | `repositoryId`, `path`, `content`, `baseBlobSha`, `baseCommitSha`, created/updated by | One draft per repository path (stacks may overlap); `baseBlobSha = null` for a new file |

- Committed content is read from Git objects of the fetched `origin/<branch>` commit, never from the working tree.
- A draft is **outdated** when the committed blob at its path no longer matches `baseBlobSha`.
- Secret-looking paths (`.env`, keys, `secrets/`) are never accepted as drafts, so no secret values are stored.
- PR #4 turns drafts into commits (and deletes them once pushed), with conflict handling for outdated drafts.

## Non-entities (explicitly out of core model)

- Container, Image, Network, Volume as first-class managed resources
- Host / Docker engine inventory
- Mutable runtime config as source of truth

## Mapping example

Wiki stack binds:

- Source root `apps/wiki`
- Deployment `portainer-webhook`
- Runtime `portainer-api` / env docker-host / stack Wiki
- Secrets Infisical path `/apps/wiki`

Folder name `wiki` alone does **not** create these bindings.
