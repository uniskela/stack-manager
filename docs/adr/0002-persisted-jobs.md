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

- At-least-once execution with idempotent handlers
- `runAfter`, attempts, dead-letter status
- Survive process restart
- Single-instance MVP: in-process lease via `status=running` + heartbeat timestamp

## When to revisit

- Multiple app replicas actively processing jobs
- Job volume exceeds SQLite write comfort
- Need delayed precision scheduling across hosts

Then introduce a queue abstraction (interface already: `JobEnqueue` port) with Redis/NATS backend — without rewriting domain handlers.
