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

- PAT / deploy key material in `ProviderCredential`
- Never log remote URLs with embedded tokens
- Support read-only vs write scopes; UI should explain required scopes for commit/push vs webhook-only

## Non-goals

- Becoming a full forge UI
- Hosting Git repositories itself
