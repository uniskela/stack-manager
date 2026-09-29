# Path-based deployment relevance and change routing

## Problem

Users should not need to wire every Portainer stack webhook directly to the Git forge. One repository webhook hits stack-manager; only affected stacks deploy.

## Router pipeline

1. Verify webhook
2. Idempotency key (delivery id / forge event id)
3. Determine changed commits and file paths
4. Map paths → candidate stacks (root scope + dependency globs)
5. Evaluate each stack’s include/exclude rules
6. Produce a **routing decision** with human-readable explanation
7. Trigger only affected `DeploymentProvider`s
8. Optionally start Deployment Watch per stack

## Example

Changed:

```text
apps/wiki/docker-compose.yml
```

Configured scopes:

| Stack | Scope |
| --- | --- |
| Wiki | `apps/wiki/**` |
| Notes | `apps/notes/**` |
| Photos | `media/photos/**` |

Result: only Wiki affected.

## Deployment relevance rules

Per-stack policy:

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

### Evaluation order (proposed)

1. Path maps to stack if under `rootPath/**` **or** matches any `dependencies` glob (repo-relative).
2. Classify each mapped path as **root-scoped** or **dependency-scoped** (matched via `dependencies`, even outside root).
3. Apply `exclude` to both classes — excluded paths do not count as deploy-relevant.
4. **Include filter applies only to root-scoped paths.** Dependency-scoped paths that survive exclude are deploy-relevant even when they match no `include` pattern (this preserves shared-path redeploys such as `shared/proxy/**`).
5. Root-scoped remaining paths must match at least one `include` (if include list non-empty). Empty include means “any non-excluded root-scoped path under scope” — **prefer requiring explicit include for safety**; document default template that includes compose filenames.
6. If zero deploy-relevant paths → skip deploy with explanation.

### Explanations (required UX)

- `Wiki will redeploy because docker-compose.yml changed.`
- `No deployment required. Only README.md changed.`
- `Wiki and Notes will redeploy because shared/proxy/nginx.conf changed (dependency path).`

## Interactive vs webhook

Same relevance engine for:

- UI “Commit → Push → Deploy”
- Forge push webhook router

## Idempotency

- Store processed webhook delivery IDs
- Re-delivery must not double-trigger deploys (unless policy `allow_redeploy_on_redelivery` — default off)
- Concurrent pushes: serialize per repository or per stack via job locks

## Audit

Record decision structure + explanation; redact secrets in URLs.

## Non-goals

- Becoming a general CI engine
- Deploying unrelated repos
- Inferring relevance from Portainer stack names
