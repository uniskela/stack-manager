# Git workflow: drafts, commits, push and history

Stack Manager turns your edits into ordinary Git commits on the repository's tracked branch. It never force
pushes, never merges or rebases on its own, and never deletes your drafts as part of a commit or push. The first
half of this page is a guide to the **Changes** and **History** tabs. The second half is the technical reference
and API contract.

```text
Edit → save draft → review Changes → validate → commit → push → fetch → History
```

Deploying the stacks a commit touched, and watching the result, are later roadmap phases
([roadmap](plans/MVP_PLAN.md)).

## Before your first commit

- **Git identity.** Set your author name and email under **Settings → Account**. Stack Manager uses exactly this
  identity for commits. It never guesses one from your username, token or server settings. Without it you can still
  browse and save drafts, but **Commit** stays disabled.
- **Write access.** Pushing needs a token that can write to the repository. A read-only token is enough to browse,
  draft and commit locally, but the push will be refused.

## Draft to commit

1. **Edit and save a draft.** In a stack's **Editor** or **Docs** tab, edit a file and choose **Save draft**
   (Ctrl+S / ⌘S). Drafts are stored in Stack Manager's database. Your repository is not touched.
2. **Review Changes.** The **Changes** tab shows every draft as a line-by-line diff against the fetched commit. The
   stack's Changes tab lists drafts inside that stack. The repository's Changes tab lists every draft in the
   repository, including files outside stacks. The tab shows a count when drafts are waiting, and the stack header
   shows a draft badge.
3. **Choose files.** Every draft starts selected. Untick any you want to leave out. Unselected drafts are not
   validated or committed, and they stay as drafts. One commit can include up to 100 files.
4. **Validation.** The selected contents are checked with the same rules as the editor:
   - **Errors** (for example, invalid YAML or a broken Compose file) always block the commit. Use the file links to
     jump back to the editor and fix them.
   - **Warnings** (including values that look like hard-coded secrets) need you to tick
     **Commit despite warnings** first. Stack Manager records that override in the activity log.
   - Informational notes never block.
5. **Write a commit message** and choose **Commit**, or **Commit & Push** to do both in one step.

A successful commit is kept on the server as a local commit on the tracked branch, ready to push. Your drafts
**stay on the server** after a commit and after a push. Once you have checked the result, discard the drafts you no
longer need from the Changes tab.

### Outdated drafts

A draft remembers the version of the file it started from. If that file has changed since, on the remote or in a
commit you already made here, the draft is **outdated** and can't be committed. The editor and Changes tab mark it
**Changed upstream**.

Saving the draft again does not move its starting point. To carry the edit forward, copy what you need from the
draft, discard it, and make the edit again on the current version. You can also untick outdated drafts and commit
the rest.

## Push

- Stack Manager pushes only to the repository's **tracked branch** (the default branch chosen when you connected it).
- Before pushing, it fetches the branch and checks that the remote is exactly where it was when you committed, and
  that your commit builds directly on it. Only then does it send an ordinary push.
- It **never force pushes**, and there is no option to. If the remote has moved, the push is stopped before
  anything is sent.
- After a successful push, choose **Fetch now** on the repository page to see the commit in **History** and to
  refresh the editor's view of the branch.

If **Commit & Push** commits but the push doesn't go through, the commit is kept. The Changes tab then offers
**Push** for that commit, so you don't have to commit the same drafts again. If you leave the tab before pushing,
choose **Commit** again. Stack Manager reports that the drafts are already in a local commit and offers **Push**
for it.

## When the remote branch changed

> The remote branch changed since your copy was last updated.

This means someone (or another tool) pushed to the branch after Stack Manager last fetched it. Stack Manager stops
rather than overwrite their work. Nothing was overwritten, and your drafts are still safe. In Git terms, the push
would not be a fast-forward.

- **If you haven't committed yet:** open the repository, choose **Fetch now**, then go back to Changes. Drafts for
  files that changed remotely are now marked outdated (see above). Everything else can be committed on top of the
  new remote version.
- **If your commit was already pushed** and others pushed after it: fetch, and keep working. New commits build on
  the latest remote version.
- **If you have a local commit that was not pushed:** Stack Manager can't merge or rebase yet, so it keeps that
  commit and won't create new commits on the branch until the commit is dealt with. Your drafts still hold the same
  changes. See [Recovering an unpushed local commit](#recovering-an-unpushed-local-commit).

## When a push fails

Every failed Git operation leaves your drafts and any local commit exactly as they were. The Changes tab explains
what happened in plain language, with the technical reason as supporting detail:

| You see | What it usually means | What to do |
| --- | --- | --- |
| The Git server refused the push | The token can't write to this branch, or a branch protection rule blocks direct pushes | Fix the permission or rule, then choose **Push** again |
| The Git server did not accept the saved credential | The token expired or was revoked | Replace it under **Settings → Credentials**, then push again |
| Could not reach the Git server / took too long | Network or server trouble | Try again later |
| Another Git operation is in progress | A fetch, commit or push is running for this repository | Wait a moment and try again |
| The branch changed while this was running | Another commit was made here at the same time | Refresh the page and review |

Error messages never include tokens, remote URLs or raw Git output.

## Stack history

Each stack's **History** tab lists the commits that touched the stack's folder, newest first, with subject, short
SHA, author and time. Open a commit to see which files changed in this stack and a line-by-line diff of each.

- History shows the repository **as of the last fetch**. A commit you just pushed appears after the next fetch.
  Local commits that were never pushed don't appear.
- A commit that touches several stacks appears in each one, showing only that stack's files.
- Documentation changes count, as do commits made outside Stack Manager.
- Secret files may be listed by name, but their contents are never shown. Binary, very large and symlinked files
  are listed without a diff.
- Renames show as a deletion at the old path and an addition at the new one.

## Recovering an unpushed local commit

If a local commit can't be pushed because the remote moved, Stack Manager keeps it and blocks new commits on that
branch. This is deliberate: it never discards a commit on its own. An in-app way to drop the local commit is planned.
Until then, an operator can remove it by hand.

1. Make sure your drafts still hold the change. They are kept unless you discarded them. If not, note the commit
   SHA shown in the Changes tab first.
2. Find the repository id in the repository page's address (`/w/<workspace>/repositories/<repository-id>`).
3. While no fetch, commit or push is running, remove the local commit reference:

   ```bash
   docker compose exec stack-manager \
     git -C /data/repos/<repository-id> update-ref -d refs/stack-manager/heads/<branch>
   ```

   This only forgets the unpushed local commit. It doesn't change the remote, the fetched copy or your drafts.
4. Choose **Fetch now**, review your drafts on the Changes tab and commit again.

# Reference

The rest of this page describes how the workflow is implemented and the API the Changes and History tabs use.

## Working tree / drafts

- Edits are stored in SQLite `source_drafts`, keyed by repository and path. Database drafts remain the canonical uncommitted state; normal editing never dirties the Git clone.
- Source reads use Git objects at the last synced commit. A draft is outdated when its `baseBlobSha` differs from the current tree entry (or a new path now exists).
- The provider accepts only explicitly selected changes and never deletes or updates drafts. `GitWorkflowService` validates selected database snapshots and orchestrates commit and optional push. It checks draft base blobs against the retained local head, including earlier unpushed commits.
- v0.5.0 preserves **all** drafts after success and failure, including edits saved concurrently with a commit. After a successful push, fetch the repository and review/discard committed drafts manually. An already committed draft can remain visible or be marked outdated; do not repeat the commit to retry a push. Automatic cleanup needs an atomic comparison against the exact committed draft snapshot and is deferred.
- Saving a draft keeps its original `baseBlobSha`, so re-saving an outdated draft does not make it committable. The operator discards it and edits the current version. A guided "update draft to the current version" flow is deferred.
- Unsaved browser buffers warn on navigation; PR #8 adds offline support.

## Validation before commit

- The existing `problemsFor` pipeline runs on exactly the selected contents: Compose checks for known Compose filenames and registered stack Compose paths, YAML/JSON syntax checks otherwise. Unselected drafts are excluded.
- Errors always block commits in v0.5.0; there is no error override.
- Warnings (including hard-coded secret warnings) require `acknowledgeWarnings: true`. A successful override records `git.commit_validation_overridden`. Informational findings do not block.
- Responses carry path, location, severity and stable problem codes. Parser messages can quote source values, so they are omitted; the editor can display detailed local validation.
- Warnings never auto-rewrite source

## Diff review

- Stack Changes: drafts under the stack's root folder, as unified diffs against each draft's base.
- Repository Changes: every draft in the repository, including files outside stacks.
- Deployment dependency paths (shared files outside a stack's folder) are not yet part of the stack scope; they arrive with deployment routing.

## Commit

- Message required
- The signed-in user's Account settings Git identity (name and email) is the author and committer. No identity is guessed from the username, Git credentials, tokens, or host Git config. If unset, reads and drafts work, but commits return `git_identity_missing`.
- Create the commit in an isolated temporary worktree; retain its object in the local clone.

## Push

- Push only to the repository's tracked (default) branch.
- Before pushing, fetch and compare the expected remote SHA and ancestry. On rejection or a remote change, return structured state, retain the local commit and every draft, and permit a separate push retry only after manual review.
- Force push is never used and is not offered.
- After a successful push, the retained ref stays on the pushed commit. Once a fetch has seen newer remote commits on top of it, branch inspection continues from the fetched head, so other people can keep pushing to the branch without blocking Stack Manager.

## Conflict protection

- Detect remote ahead
- v0.5.0 requires manual reconciliation outside the app. Fetch is available through the existing repository sync route; branch inspection also fetches remote refs without changing the source snapshot. Neither operation merges, rebases, moves the retained local head, or deletes drafts.
- An **unpushed** retained commit behind a moved remote blocks further commits on that branch until it is removed by hand (see [Recovering an unpushed local commit](#recovering-an-unpushed-local-commit)). An in-app discard action is a planned follow-up.
- Block when remote commits would be lost. No hard reset, force push, or automatic merge/rebase is implemented.

## Implementation overview (v0.5.0)

The low-level `GitProvider` supports `inspectBranch`, `commit`, `push`, and `getCommit` for all three smart-HTTP adapters. `GitWorkflowService` provides the application/API layer. The Changes tab commits selected drafts and can push or retry a retained commit. The History tab reads the stack-scoped history API below.

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

## Branch / PR workflow (deferred)

v0.5.0 commits and pushes directly to the tracked branch only. A forge branch and pull request flow was optional for
this phase and did not ship. If added later, it would be capability-gated per `GitProvider`:

- Create a branch from selected drafts
- Open a PR toward the default branch
- Deployment policy may require a merge to the default branch (configurable)

## Security

- Secret-looking files (`.env*` except templates, keys, certificates, `secrets/`) can never be drafted, selected or committed; their contents never reach the browser, drafts, history diffs or commits.
- Values that look like hard-coded secrets in Compose files are warnings that need explicit acknowledgement. The override is audited without the value.
- Tokens are sent to `git` as a per-process HTTP header, never in remote URLs, argv, `.git/config`, logs, audit events or API responses. Workflow failures expose only a coarse `reason` code.
- No force push, mirror push, tag push, hooks or commit signing. No merge, rebase or hard reset.
- Failed or rejected Git operations never delete drafts or the retained local commit.

## Non-goals

- Full IDE merge tool competing with VS Code (an in-app conflict editor is not planned for v0.5.0)
- Hosting the Git server
