# Deployment Watch architecture

## Intent

Feel like **CI/CD deployment feedback**, not like a container orchestrator.

When the user (or router) performs deploy after Git change:

1. Capture **pre-deployment** runtime snapshot (if RuntimeProvider bound)
2. Trigger selected DeploymentProvider
3. Observe associated RuntimeProvider
4. Identify changes to the stack’s containers
5. Display a timeline
6. Wait for runtime state to stabilise
7. Report result

## Example timeline

```text
Commit pushed          ✓
Deployment requested   ✓
Old container stopped  ✓
New container created  ✓
Container running      ✓
Healthcheck healthy    ✓
```

Useful change presentations:

- old image → new image
- previous container → new container
- starting → healthy
- restart loops
- unhealthy state
- unexpected stopped services
- healthcheck timeout

## State machine (logical)

```text
pending → triggering → observing → healthy
                              ↘ failed
                              ↘ timed_out
                              ↘ skipped_no_runtime
```

`skipped_no_runtime`: deploy trigger still recorded; watch observation steps marked skipped.

## Failure context UI

When something fails after deployment, correlate:

```text
Git change
↕
Compose diff
↕
deployment event
↕
container/runtime result
↕
recent logs
```

Example panel:

```text
Deployment requires attention

Container: app
State: restarting
Restart count: 4

Recent logs:
Database connection refused

Changed configuration:
docker-compose.yml lines 31-36

Git:
c72ca81 "update Wiki image"

Actions:
- View Diff
- View Logs
- Open in Portainer
```

**Do not** expose destructive runtime actions by default.

## Implementation notes

- Watch runs as persisted `deployment_watch` job (ADR 0002)
- Poll RuntimeProvider with backoff; cap max duration (configurable per stack)
- Store timeline events append-only
- Snapshots are observational JSON; size-limit logs
- Redact likely secrets in log snippets before persistence/display

## Non-goals

- Rolling restarts, scale, exec, or “fix it” buttons that mutate runtime
- Replacing Portainer’s troubleshooting workflows — deep-link out instead
