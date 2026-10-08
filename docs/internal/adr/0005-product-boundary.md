# ADR 0005 — Product boundary: source workspace, not container manager

## Status

Accepted (PR #1)

## Context

Adjacent tools (Portainer, Komodo, Arcane, UniHomelabDash) manage or observe running containers. Collapsing into that category would duplicate them and blur the product.

## Decision

stack-manager’s primary responsibility is managing **source files and Git workflow** that describe self-hosted application stacks, plus **deployment triggers** and **optional read-only runtime observation**.

Explicitly out of core scope: Containers / Images / Networks / Volumes management pages; destructive Docker controls; making runtime authoritative.

## Consequences

- DeploymentProvider and RuntimeProvider stay separate
- UI hierarchy keeps editing first
- Feature proposals resembling “Portainer alternative” are rejected or redesigned
- Deep-links out to external ops UIs are preferred over re-implementing them
