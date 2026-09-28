# ADR 0004 — Modular monolith

## Status

Accepted (PR #1)

## Context

Separate frontend and API services add ops overhead for a self-hosted MVP. Serverless splits conflict with webhook workers and local git clones.

## Decision

Ship one **modular monolith**: Next.js UI + server routes/services + background worker in one process/container. Enforce module boundaries by folder (domain, providers, persistence, ui) rather than network.

## Consequences

- Simple Docker Compose for operators
- Clear path to extract workers later if needed
- Must keep provider adapters isolated so Portainer never becomes a core import of domain layer
