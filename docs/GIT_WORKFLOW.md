# Git editing, commit, and push workflow

## Happy path

```text
Edit → Validate → Commit → Push → (optional) Deploy → (optional) Watch
```

## Working tree / drafts

- Edits are stored in SQLite `source_drafts`, keyed by repository and path. Database drafts remain the canonical uncommitted state; normal editing never dirties the Git clone.
- Source reads use Git objects at the last synced commit. A draft is outdated when its `baseBlobSha` differs from the current tree entry (or a new path now exists).
- The provider accepts only explicitly selected changes and never deletes or updates drafts, even after commit or push succeeds. The later application workflow owns draft reconciliation.
- Unsaved browser buffers warn on navigation; PR #8 adds offline support.

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
- Create the commit in an isolated temporary worktree; retain its object in the local clone.

## Push

- Push to tracked branch
- On rejection (non-fast-forward): block, fetch, show conflict protection UI — no silent force push
- Force push: not offered in MVP

## Conflict protection

- Detect remote ahead
- Offer rebase/merge strategies appropriate to self-hosted single-operator MVP (document chosen default in PR #4)
- Block when remote commits would be lost. No hard reset, force push, or automatic merge/rebase is implemented.

## Implemented provider foundation (PR #4)

The low-level `GitProvider` now supports `inspectBranch`, `commit`, `push`, and `getCommit` for all three smart-HTTP adapters. The final commit/push UI and application orchestration are separate work.

A commit operation:

1. Validates the configured clone directory, tracked branch, expected HEAD, author/message and selected paths.
2. Acquires an exclusive per-repository filesystem lock shared with clone/fetch and push operations.
3. Fetches the tracked remote branch. Compares its history with the retained local mutation head (or the previously fetched head before the first local commit). Blocks remote-ahead/divergent state and an unexpected HEAD.
4. Reads the expected commit tree through `SourceTreeReader` and verifies every selected base blob. Refuses secret paths, symlinks, submodules, directory collisions and duplicate selections.
5. Creates a detached `git worktree add --no-checkout` under `<dataDir>/repos/.mutation-*`. Loads the expected tree into its isolated index; repository files are never checked out.
6. Writes only selected text changes, hashes exact bytes with filters disabled, and stages only those paths with `update-index`. Unselected files stay at the expected commit; the read clone's files and index remain untouched.
7. Creates the commit with the supplied author/committer identity, disabled hooks/signing and a required message. Returns SHA, parents, message, identities and timestamps.
8. Removes the owned worktree and temporary directory in `finally`, without forwarding a cancelled signal to cleanup. If removal fails, retries only that worktree; never prunes unrelated worktrees. Cleanup errors are surfaced. Only after cleanup succeeds does a compare-and-swap publish the new head under `refs/stack-manager/heads/<branch>`.

The private ref retains unpushed commits across fetches and permits successive local commits without moving the read clone's checked-out branch. A sync only refreshes remote-tracking refs and the database source snapshot.

Push is an explicit operation with a known retained commit SHA and an expected remote SHA. It fetches again, checks exact heads and ancestry, then uses one ordinary SHA-to-branch refspec with no force, mirror or tag-following options. A remote race is still protected by Git's non-fast-forward rejection. Failed pushes retain the local commit and all drafts for review/retry. Remote rejection, conflict, authentication, network and busy conditions are distinct provider failures. Remote deletion blocks the operation; it never recreates a missing branch automatically.

Locks use exclusive owner-only files and fail closed (`busy`) across provider instances/processes sharing the data volume. Normal completion/failure releases the lock after worktree cleanup. A process/host crash can leave `.lock-<repository id>` and `.mutation-*` state: stop all app processes using the data directory before manually removing a confirmed stale lock or its owned worktree. There is no timeout-based lock stealing or automatic pruning; crash recovery and merge/rebase resolution belong to later orchestration.

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
