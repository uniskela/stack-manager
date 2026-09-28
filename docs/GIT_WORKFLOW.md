# Git editing, commit, and push workflow

## Happy path

```text
Edit → Validate → Commit → Push → (optional) Deploy → (optional) Watch
```

## Working tree / drafts

- Edits apply to a per-repository working copy under the data directory (or isolated worktree)
- UI shows dirty state scoped to current stack when possible
- Unsaved browser buffers should warn on navigation; PR #8 adds offline-safe draft persistence

## Validation before commit

- YAML/Compose validation errors block commit by default (override requires explicit confirm)
- Soft warnings: runtime unhealthy, Git↔runtime image drift, missing secret metadata keys
- Warnings never auto-rewrite source

## Diff review

- Stack-scoped diff (files under stack root + touched dependency paths)
- Full repo diff available for power users
- Line-level view for failure correlation later

## Commit

- Message required
- Author from authenticated user profile / configured git identity
- Create commit in local clone

## Push

- Push to tracked branch
- On rejection (non-fast-forward): block, fetch, show conflict protection UI — no silent force push
- Force push: not offered in MVP

## Conflict protection

- Detect remote ahead
- Offer rebase/merge strategies appropriate to self-hosted single-operator MVP (document chosen default in PR #4)
- Never discard remote commits without explicit destructive confirm (and still avoid hard reset defaults)

## Stack-scoped history

- List commits touching stack paths
- Link commit → files → deploy events

## Optional branch / PR architecture

Where `GitProvider` capabilities allow:

- Create branch from draft
- Open PR toward default branch
- Deploy policy may require merge to default branch (configurable)

MVP may ship commit-to-default-branch first; PR flow is optional enhancement inside PR #4 if timeboxed.

## Security

- Do not commit `.env` with secrets; warn on matched secret file patterns
- Pre-commit checklist for credential-looking strings (heuristic)

## Non-goals

- Full IDE merge tool competing with VS Code
- Hosting the Git server
