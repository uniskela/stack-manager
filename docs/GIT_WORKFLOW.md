# Git editing, commit, and push workflow

## Happy path

```text
Edit → Validate → Commit → Push → (optional) Deploy → (optional) Watch
```

## Working tree / drafts

- Edits are stored in SQLite `source_drafts`, keyed by repository and path. Database drafts remain the canonical uncommitted state; normal editing never dirties the Git clone.
- Source reads use Git objects at the last synced commit. A draft is outdated when its `baseBlobSha` differs from the current tree entry (or a new path now exists).
- The provider accepts only explicitly selected changes and never deletes or updates drafts. `GitWorkflowService` validates selected database snapshots and orchestrates commit and optional push. It checks draft base blobs against the retained local head, including earlier unpushed commits.
- v0.5.0 preserves **all** drafts after success and failure, including edits saved concurrently with a commit. After a successful push, fetch the repository and review/discard committed drafts manually. An already committed draft can remain visible or be marked outdated; do not repeat the commit to retry a push. Automatic cleanup needs an atomic comparison against the exact committed draft snapshot and is deferred.
- Unsaved browser buffers warn on navigation; PR #8 adds offline support.

## Validation before commit

- The existing `problemsFor` pipeline runs on exactly the selected contents: Compose checks for known Compose filenames and registered stack Compose paths, YAML/JSON syntax checks otherwise. Unselected drafts are excluded.
- Errors always block commits in v0.5.0; there is no error override.
- Warnings (including hard-coded secret warnings) require `acknowledgeWarnings: true`. A successful override records `git.commit_validation_overridden`. Informational findings do not block.
- Responses carry path, location, severity and stable problem codes. Parser messages can quote source values, so they are omitted; the editor can display detailed local validation.
- Warnings never auto-rewrite source

## Diff review

- Stack-scoped diff (files under stack root + touched dependency paths)
- Full repo diff available for power users
- Line-level view for failure correlation later

## Commit

- Message required
- The signed-in user's Account settings Git identity (name and email) is the author and committer. No identity is guessed from the username, Git credentials, tokens, or host Git config. If unset, reads and drafts work, but commits return `git_identity_missing`.
- Create the commit in an isolated temporary worktree; retain its object in the local clone.

## Push

- Push to tracked branch
- Before pushing, fetch and compare the expected remote SHA and ancestry. On rejection or a remote change, return structured state, retain the local commit and every draft, and permit a separate push retry only after manual review.
- Force push: not offered in MVP

## Conflict protection

- Detect remote ahead
- v0.5.0 requires manual reconciliation outside the app. Fetch is available through the existing repository sync route; branch inspection also fetches remote refs without changing the source snapshot. Neither operation merges, rebases, moves the retained local head, or deletes drafts.
- Block when remote commits would be lost. No hard reset, force push, or automatic merge/rebase is implemented.

## Implemented provider foundation (PR #4)

The low-level `GitProvider` supports `inspectBranch`, `commit`, `push`, and `getCommit` for all three smart-HTTP adapters. `GitWorkflowService` provides the application/API layer. The Changes tab commits selected drafts and can push or retry a retained commit.

## Application API contract (v0.5.0)

Base: `/api/workspaces/{workspaceId}/repositories/{repositoryId}/git`.
All routes require an active admin session and a workspace-scoped repository. POSTs use the existing same-origin/JSON rules. The current single-operator admin can access all workspaces; a repository under another workspace id is a 404. These APIs never accept source content, an author identity, raw Git commands, or force options.

| Route | Input | Purpose |
| --- | --- | --- |
| `GET /git` | — | Fetch/inspect retained local and remote heads; no draft or source-snapshot changes |
| `POST /git/commit` | `{ "paths": ["apps/wiki/compose.yaml"], "message": "Update wiki", "push": false, "acknowledgeWarnings": false }` | Commit precisely these server-side drafts, optionally push |
| `POST /git/push` | `{ "commitSha": "<retained SHA>", "expectedRemoteSha": "<reviewed remote SHA>" }` | Push/retry the retained commit without committing drafts again |

Commit selections must contain 1–100 unique, canonical, non-secret paths with existing drafts. Messages must be nonblank, NUL-free and at most 8,192 characters / 32 KiB UTF-8. Requests reject unknown fields and use the standard 64 KiB body limit. Push ids are full SHA-1 or SHA-256 object ids.

Every workflow response has this shape (TypeScript definitions: `src/shared/git-workflow.ts`):

```json
{
  "status": "commit_succeeded",
  "repositoryId": "repository-id",
  "branch": "main",
  "operation": "commit",
  "commitSha": "<new SHA>",
  "expectedRemoteSha": "<reviewed remote SHA>",
  "state": {
    "branch": "main",
    "localHeadSha": "<last inspected local SHA>",
    "remoteHeadSha": "<last inspected remote SHA>",
    "ahead": 0,
    "behind": 0
  },
  "problems": [],
  "outdatedPaths": [],
  "draftsPreserved": true
}
```

`state` is the last successful inspection, nullable when inspection failed. It can precede the returned commit or push; refresh `GET /git` to display current heads. On conflict/rejection, the service refreshes it best-effort. `expectedRemoteSha` retains the reviewed remote head separately from that refreshed state; it is null for inspection or if commit inspection failed. `commitSha` identifies the successful commit made by this request, or the explicit SHA of a push request; it remains present when a subsequent push fails. A commit failure before publication has `commitSha: null`. Never infer commit success from HTTP success alone: a combined request can return 409/502 **with a successful retained commit**.

| HTTP | `status` | UI action |
| --- | --- | --- |
| 200 | `ready` | Show inspected heads; this does not prove push permission |
| 200 | `commit_succeeded` | Show commit; offer a separate push |
| 200 | `push_succeeded` | Show pushed commit; fetch and review remaining drafts |
| 422 | `validation_blocked` | Correct selected files; errors cannot be overridden |
| 422 | `warnings_unacknowledged` | Show warnings, request explicit acknowledgement, then resubmit |
| 409 | `draft_outdated` | Review `outdatedPaths` against the current local tree |
| 409 | `git_identity_missing` | Set Git identity under Settings → Account |
| 409 | `remote_changed` | Show heads/ahead/behind; fetch and reconcile manually |
| 409 | `branch_changed` | Local head changed or the selected commit was superseded; refresh/review |
| 409 | `push_rejected` | Remote refused the push; review permissions/policy; retained work can be retried |
| 409 | `repository_busy` | Another Git operation owns the lock; retry when it finishes |
| 502 | `git_operation_failed` | Show operation and safe `reason`; preserve/review retained commit and drafts |

Git failures additionally include `reason`: `auth`, `not_found`, `network`, `timeout`, `invalid`, `conflict`, `busy`, `rejected`, or `unknown`. No provider exception text is returned or audited. Validation problems use `{ path, line, column, severity, code }`, where `code` is `source_error`, `source_warning`, `source_info`, or `hardcoded-secret`. The editor uses the same validation pipeline for details.

Malformed selection/body and access/precondition errors keep the existing `{ "error": { "code", "message", "fields" } }` envelope: 400 `validation_failed`, 401 `unauthenticated`, 403 `forbidden`, 404 `not_found`, 409 `not_synced`, plus the wrapper's media-type/body-size errors. Clients must handle this envelope as well as workflow outcomes without parsing messages.

Audit uses `git.commit`, `git.push`, `git.push_rejected` and `git.commit_validation_overridden`, with ids, branch, SHA, file/warning counts and affected registered stack ids where available. Draft contents, commit messages, identities, remote URLs and credentials are omitted.

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

## Stack-scoped history API (v0.5.0)

All four read-only routes require an active admin session and workspace-scoped access:

| Route | Scope |
| --- | --- |
| `GET /api/workspaces/{workspaceId}/stacks/{stackId}/history` | The registered stack's repository-relative `rootPath` and descendants |
| `GET /api/workspaces/{workspaceId}/stacks/{stackId}/history/{sha}` | Relevant changed files and structured line diffs for one commit |
| `GET /api/workspaces/{workspaceId}/repositories/{repositoryId}/history` | The whole repository, including files outside stacks |
| `GET /api/workspaces/{workspaceId}/repositories/{repositoryId}/history/{sha}` | Repository-wide commit detail using the same implementation |

History uses actual paths, independent of the stack's display name or slug. An empty stack root
covers the whole repository, including nested stacks. A shared commit appears in each affected stack;
its file list and diff contain only that route's scope. Documentation changes count. Deployment
include/exclude/dependency rules are not part of this API; those rules are not yet persisted on stacks.

History reads the database's **last fetched SHA**, without fetching, moving refs or reading the working
tree. Retained unpushed commits and drafts become part of this history only after push and fetch.
Traversal includes reachable branch commits; merge changes compare against the first parent.
Initial commits compare against the empty tree. Renames deliberately appear as deletion/addition at
the old/new paths, including moves across stack boundaries; history does not follow a file's old name.

List query parameters: `limit` (integer 1–50, default 20) and `cursor` (opaque `nextCursor` from the
previous response). Unknown or duplicate parameters are rejected. Pass the cursor unchanged; omit
`limit` on subsequent pages or keep the same value. A cursor is bound to repository, root, page size
and head SHA, so new fetches do not shift an in-progress page sequence. If the anchor is no longer
reachable after a rewritten history, start again on 409 `history_changed`.

Response types are in `src/shared/git-history.ts`. Lists return:

```json
{
  "repositoryId": "repository-id",
  "rootPath": "apps/wiki",
  "headSha": "<fetched SHA>",
  "commits": [{
    "sha": "<full SHA>",
    "shortSha": "<first 7 characters>",
    "parents": ["<parent SHA>"],
    "subject": "Update wiki",
    "message": "Update wiki\n\nFull commit body\n",
    "author": { "name": "Operator", "email": "operator@example.invalid" },
    "authoredAt": "2026-10-07T12:00:00+00:00",
    "committedAt": "2026-10-07T12:00:00+00:00",
    "files": [{ "path": "apps/wiki/compose.yaml", "status": "modified" }],
    "filesTruncated": false
  }],
  "nextCursor": null,
  "historyLimitReached": false
}
```

An empty history returns `commits: []`, `nextCursor: null`. Commits are in Git's newest-first traversal
order. File status is `added`, `modified`, `deleted` or `type_changed`. Paths stay repository-relative.
Timestamps are ISO 8601 strings; messages and identities are plain text, **never HTML**.

Details return `{ repositoryId, rootPath, headSha, commit }`. `commit` has the same metadata,
`filesTruncated`, and `diffBaseSha` (first parent or null). Each file adds `locked` and `hunks`:

```json
{
  "path": "apps/wiki/compose.yaml",
  "status": "modified",
  "locked": null,
  "hunks": [{
    "oldStart": 1, "oldLines": 1, "newStart": 1, "newLines": 1,
    "lines": ["-image: wiki:1", "+image: wiki:2"]
  }]
}
```

Hunks have three lines of context. Lines use the standard unified-diff prefixes (`+`, `-`, space,
with `\ No newline at end of file` markers where needed). An empty hunk array means no textual
changes (for example, executable mode only). `hunks: null` means unavailable content, with `locked`
set to `secret`, `symlink`, `submodule`, `binary`, `too_large`, `diff_limit` or `unsupported_path`.
Git filenames unsupported by the editor (for example, newline or trailing-space names) remain
visible as JSON metadata but their contents are locked. Secret filenames may
appear in history but their contents never enter the diff reader. Binary detection matches the
editor's NUL-byte rule. Changes are read from Git objects through the existing source-reader port;
no raw Git patches or stderr are exposed.

Limits: 50 commits/page, maximum cursor offset 10,000, 100 returned files/commit
(`filesTruncated: true` when more exist), 256 KiB per blob side and 1 MiB of total blob reads/detail.
Diff computation is bounded to 50 ms and 10,000 edits per file; exhausted diffs return `diff_limit`.
At the pagination ceiling, `nextCursor` is null and `historyLimitReached` is true even if more commits
exist. Git commands have a 30-second timeout and bounded output; metadata over 64 KiB or more than
500 relevant changed files fails closed with 502 `git_history_failed`.

Errors use the existing `{ "error": { "code", "message", "fields" } }` envelope:
400 `validation_failed` for invalid pages/cursors or non-full SHAs; 401 `unauthenticated`;
403 `forbidden`; 404 `not_found` when a resource or commit is missing or outside the fetched
history/scope; 409 `not_synced` before fetch; 409 `history_changed` for stale anchors;
502 `git_history_failed` for bounded or failed Git reads. Error messages never include Git output.
Commit/deployment correlation remains later work.

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
