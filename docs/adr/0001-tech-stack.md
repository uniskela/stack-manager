# ADR 0001 — Tech stack

## Status

Accepted (PR #1)

## Context

Greenfield self-hosted application. Needs durable local data, long-running background work, and a modern TypeScript web UI. Must not be designed around Vercel/serverless constraints.

## Decision

- **Next.js** (App Router) + **TypeScript**
- **Drizzle ORM**
- **SQLite** initially for storage
- Single **Docker** deployable Node process (modular monolith)
- Persistence accessed via repository ports so **PostgreSQL** migration stays practical

## Consequences

- Familiar Uniskela self-host patterns; good DX
- SQLite concurrent write limits — document PG for larger multi-user later
- Next.js used as full server, not edge/serverless target
- Background jobs co-located (see ADR 0002)
