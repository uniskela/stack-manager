# ADR 0002 — Lightweight persisted jobs (no Redis MVP)

## Status

Accepted (PR #1)

## Context

Forge webhooks and Deployment Watch require reliable asynchronous processing inside a long-running Docker deployment. Options: in-memory only, Redis/BullMQ, or DB-backed jobs.

## Decision

Use a **persisted job table** in the application database plus an **in-process worker** (poller or `LISTEN`-free interval) inside the same Node service.

Avoid Redis or extra infrastructure unless a measured requirement appears (multi-instance horizontal scale, very high webhook volume).

## Job types (initial)

- `git_webhook`
- `deployment_trigger`
- `deployment_watch`
- `provider_connection_test` (optional async)
- `credential_reencrypt` (future)

## Guarantees

- At-least-once execution with **idempotent handlers**
- `runAfter`, attempts, dead-letter (`dead`) status
- Survive process restart via DB state
- Single-instance MVP: lease fields on `Job` (`leaseOwner`, `leaseExpiresAt`, `heartbeatAt`) — see [DATA_MODEL.md](../domain/DATA_MODEL.md)

## Lease and restart recovery

Lease state is persisted on the `Job` row (not only in memory).

1. Claim: atomically set `status=running`, `leaseOwner=<workerId>`, `leaseExpiresAt=now+leaseTtl`, `heartbeatAt=now` where status is `pending` (or reclaimable — below).
2. Heartbeat: while working, refresh `heartbeatAt` and extend `leaseExpiresAt` on an interval (e.g. every 10s; TTL e.g. 60s).
3. Complete: set `succeeded` / `failed` / `dead` and clear lease fields.
4. Reclaim after crash: any worker (including after process restart) may requeue a job when `status=running` **and** `leaseExpiresAt < now`. Requeue means `status=pending`, clear lease fields, increment `attempts`, honour `runAfter` backoff.
5. Stale `running` without expiry must not occur — claiming always sets `leaseExpiresAt`.

Default lease TTL and heartbeat interval are implementation constants documented at coding time in PR #2/#5.

### Implementation constants (PR #2)

Defined in `src/server/domain/job.ts`:

| Constant | Value |
| --- | --- |
| Lease TTL | 60 s |
| Heartbeat interval | 10 s |
| Poll interval (idle) | 1 s (API routes can nudge the worker immediately) |
| Retry backoff | 5 s × 2^(attempt−1), capped at 15 min |
| Default max attempts | 5 |

Status semantics: a handler error retries (`pending` + backoff) until attempts are exhausted → `dead`;
a `PermanentJobError` (retrying cannot help, e.g. revoked credential) → `failed`. Terminal and retry
transitions are fenced on `leaseOwner`, so a worker that lost its lease cannot overwrite the new owner's result;
heartbeat failure aborts the handler via `AbortSignal`. An optional `dedupeKey` (partial unique index over
active jobs) prevents duplicate pending work. Payloads must not contain secrets — enqueue rejects any payload
the redactor would alter. Job type added in PR #2: `repository_sync` (clone or fetch a repository connection).

## Idempotency for `deployment_trigger`

Inbound forge webhook **delivery IDs** prevent duplicate job creation. That alone does **not** protect a `deployment_trigger` that already called the provider, recorded acceptance, then crashed before marking the job succeeded.

Rules:

1. `TriggerDeploymentInput.idempotencyKey` is **required** (stable `job.id`, optionally combined with forge delivery id).
2. Before calling `DeploymentProvider.trigger`, persist an intent row / set job payload flag `triggerAttemptedAt`.
3. After provider returns `accepted=true` (or equivalent), set `Job.acceptanceRecordedAt` **before** marking succeeded.
4. On reclaim/retry:
   - If `acceptanceRecordedAt` is set → **do not** call the provider again; continue to enqueue Deployment Watch / mark succeeded.
   - If not set → retry `trigger` with the same `idempotencyKey`.
5. Adapters SHOULD send the key to the remote when supported (e.g. `Idempotency-Key` header on generic webhooks). Portainer stack webhooks may ignore headers; acceptance recording still prevents blind double-fire after known acceptance.
6. Providers that cannot dedupe must document that uncertain pre-acceptance crashes may double-trigger; keep lease TTL short and prefer recording acceptance promptly.

## When to revisit

- Multiple app replicas actively processing jobs
- Job volume exceeds SQLite write comfort
- Need delayed precision scheduling across hosts

Then introduce a queue abstraction (interface already: `JobEnqueue` port) with Redis/NATS backend — without rewriting domain handlers.
