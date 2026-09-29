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

## Implementation status (PR #2)

- `GitProvider` (`src/server/providers/git/types.ts`) currently exposes the foundation subset:
  `testConnection` (via `git ls-remote --symref`), `syncClone` (atomic clone into a temp dir then rename, or
  fetch), `listBranches`, plus a `descriptor` with display metadata and `capabilities`. Commit/push (PR #4) and
  webhook verification/parsing (PR #5) extend the interface.
- `github`, `gitea` and `forgejo` are registered; they share one smart-HTTP implementation using the `git`
  binary (the forge API is not needed yet). The core validates provider types against the registry and never
  branches on a forge name. GitLab can be added as another descriptor/adapter.
- Remotes are HTTPS only in PR #2; SSH remotes (keys + host-key pinning) are deferred.
- Tokens are sent as HTTP Basic auth (`username` from credential metadata, default `x-access-token`, which
  GitHub, Gitea and Forgejo accept with a token as the password).
- `webhookCredentialId` exists in the schema and stays null until PR #5.
- The local clone is a mirror for reading; working-tree/draft handling is decided in PR #4.

## Non-goals

- Becoming a full forge UI
- Hosting Git repositories itself
