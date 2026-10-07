# GitProvider abstraction

## Purpose

Abstract Git forges so core workflows do not hard-code GitHub.

## Capability interface (logical)

```ts
interface GitProvider {
  readonly type: string;

  // Connection
  testConnection(cred: ResolvedCredential): Promise<Result>;

  // Repository
  ensureClone(conn: GitRepositoryConnection): Promise<void>;
  fetch(conn: GitRepositoryConnection): Promise<void>;
  listBranches(conn: GitRepositoryConnection): Promise<string[]>;
  readFile(conn: GitRepositoryConnection, path: string, ref?: string): Promise<string>;
  listTree(conn: GitRepositoryConnection, path: string, ref?: string): Promise<TreeEntry[]>;

  // Mutations (local + push)
  commit(conn: GitRepositoryConnection, input: CommitInput): Promise<{ sha: string }>;
  push(conn: GitRepositoryConnection, opts: PushOptions): Promise<void>;

  // Webhooks
  verifyWebhook(req: WebhookRequest, secret: string): Promise<boolean>;
  parsePushEvent(req: WebhookRequest): Promise<PushEvent>;

  // Optional forge features
  capabilities: {
    pullRequests: boolean;
    commitStatuses: boolean;
  };
  // Optional methods only if capability true
}
```

## Planned adapters

| Type | Notes |
| --- | --- |
| `github` | API + `git` CLI/isomorphic-git; webhook HMAC |
| `gitea` | API compatible family |
| `forgejo` | Treat adjacent to Gitea |
| `gitlab` | Later |

Prefer **local git operations** (clone/fetch/commit/push) via a maintained library or `git` binary in the container for correctness on large monorepos. Forge HTTP APIs for webhook parsing, PR creation (optional), and connection tests.

## Webhook contract

One repository webhook → stack-manager:

1. Verify signature
2. Persist idempotent delivery id
3. Enqueue `git_webhook` job
4. Worker computes changed paths across commits
5. Router maps to stacks (see [DEPLOYMENT_ROUTING.md](../DEPLOYMENT_ROUTING.md))

## Credentials

- PAT / deploy key material in `ProviderCredential` (clone/push), separate from `webhookCredentialId` on the repository connection
- Webhook verification decrypts the webhook credential only long enough to compute the HMAC; never return it to clients
- Use HTTPS for forge API requests and HTTPS or SSH for credential-bearing Git remotes; reject plaintext `http://` / `git://` protocols before sending credentials
- Never log remote URLs with embedded tokens
- Support read-only vs write scopes; UI should explain required scopes for commit/push vs webhook-only

## Implementation status (v0.5.0)

- `GitProvider` (`src/server/providers/git/types.ts`) currently exposes the foundation subset:
  `testConnection` (via `git ls-remote --symref`), `syncClone` (atomic clone into a temp dir then rename, or
  fetch), `listBranches`, `inspectBranch`, `commit`, `push` and `getCommit`, plus a `descriptor` with display metadata and `capabilities`.
  Webhook verification/parsing remains PR #5.
- `github`, `gitea` and `forgejo` are registered; they share one smart-HTTP implementation using the `git`
  binary (the forge API is not needed yet). The core validates provider types against the registry and never
  branches on a forge name. GitLab can be added as another descriptor/adapter.
- Remotes are HTTPS only; SSH remotes (keys + host-key pinning) are deferred.
- Tokens are sent as HTTP Basic auth (`username` from credential metadata, default `x-access-token`, which
  GitHub, Gitea and Forgejo accept with a token as the password).
- `webhookCredentialId` exists in the schema and stays null until PR #5.
- The local clone is a normal read clone, not a bare mirror. SQLite drafts remain canonical. Commits use detached temporary worktrees with isolated indexes and no checkout; pending heads are retained under private refs.
- All mutation/fetch operations share an exclusive repository lock. Production adapters receive the allowed repositories directory from the composition root; mutation paths and Git metadata cannot escape it. Remote host policy remains the application caller's responsibility, as for sync; the provider additionally validates HTTPS URLs without embedded credentials.
- Push never uses force, mirror or tag options. Pushing requires write access in the token; the UI explains a refused
  push without returning provider output.
- Forge pull requests and commit statuses are not implemented (`capabilities.pullRequests` / `commitStatuses` are
  `false`); the v0.5.0 workflow commits directly to the tracked branch.
- Commit inputs map selected drafts to `{ path, content, baseBlobSha }` with an expected branch HEAD and author identity; `content: null` supports controlled deletion. Push requires an exact retained commit and expected remote SHA. Neither operation touches draft persistence.
- See [Git workflow](../GIT_WORKFLOW.md#implementation-overview-v050) for remote protection, cleanup and crash-recovery limits.

## Non-goals

- Becoming a full forge UI
- Hosting Git repositories itself
