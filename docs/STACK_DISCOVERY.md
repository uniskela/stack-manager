# Repository and stack discovery

## Principles

1. A Git repository may contain many stacks (monorepo).
2. Stacks are **explicit** records with `rootPath` + `composePath`.
3. Discovery helpers may **suggest** stacks; they never silently create authoritative bindings to deploy/runtime/secrets.
4. Folder names alone do not imply Portainer stack names or webhook targets.

## Compose file detection

Recognise (case-sensitive as on disk; document Windows caveats):

- `compose.yml` / `compose.yaml`
- `docker-compose.yml` / `docker-compose.yaml`

Optional: Compose `include:` / extension files later; MVP focuses on primary compose path per stack.

## Suggestion algorithm (assisted setup)

When connecting a repository:

1. Fetch default branch
2. Walk tree (bounded depth / ignore heavy dirs: `.git`, `node_modules`, image layers, etc.)
3. Find candidate directories containing a compose file
4. Present candidates for user confirmation → create `Stack` rows
5. Leave Deployment/Runtime/Secret bindings empty until configured

## Configurable stack scopes

Each stack has:

- `rootPath` — e.g. `apps/wiki`
- Path policy globs for deploy relevance (see [DEPLOYMENT_ROUTING.md](DEPLOYMENT_ROUTING.md))
- Optional docs globs under root

Scope matching for routing uses glob semantics (document library choice in PR #5, e.g. `picomatch` / `micromatch`).

## Documentation discovery

Suggest README/docs under stack root for Docs tab; user can override paths.

## Environment references

From compose + `.env.example`:

- Collect variable names referenced (`${VAR}`, `env:` keys, etc.)
- Do not read `.env` production files into the UI by default
- Prefer `.env.example` as the documented contract

## Validation

- YAML parse
- Compose schema / `docker compose config` equivalent where feasible in-container (optional dependency; document trade-offs)
- Cross-stack include path warnings

## Anti-patterns

- Auto-creating Portainer bindings from directory names
- Assuming one-repo-one-stack
- Scanning and storing host Docker state during discovery
