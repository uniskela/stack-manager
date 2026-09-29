/**
 * GitProvider capability interface (docs/providers/GIT_PROVIDER.md).
 *
 * PR #2 implements the connection/clone/fetch/metadata subset. Commit/push (PR #4) and webhook
 * verification/parsing (PR #5) extend this interface later; `capabilities` advertises optional
 * forge features so core code never branches on a specific forge name.
 */

/** Plaintext credential material, resolved server-side for the duration of one operation only. */
export interface GitHttpAuth {
  username: string;
  token: string;
}

export interface RemoteProbe {
  defaultBranch: string | null;
  branches: string[];
}

export interface GitProviderCapabilities {
  pullRequests: boolean;
  commitStatuses: boolean;
  webhooks: boolean;
}

export interface GitProviderDescriptor {
  type: string;
  displayName: string;
  /** Example clone URL for form placeholders. */
  exampleUrl: string;
  /** Guidance on token scopes shown next to the credential field. */
  tokenHelp: string;
  capabilities: GitProviderCapabilities;
}

export interface GitProvider {
  readonly descriptor: GitProviderDescriptor;

  /** Default HTTP username when a token is used without an explicit username. */
  defaultUsername(): string;

  /** Probes the remote (no clone): verifies reachability/auth and returns HEAD + branches. */
  testConnection(remoteUrl: string, auth: GitHttpAuth | null, signal?: AbortSignal): Promise<RemoteProbe>;

  /** Clones into `targetDir` if missing (atomically via a temp dir), otherwise fetches. Returns origin/<branch> sha. */
  syncClone(input: {
    remoteUrl: string;
    branch: string;
    targetDir: string;
    auth: GitHttpAuth | null;
    signal?: AbortSignal;
  }): Promise<{ headSha: string; cloned: boolean }>;

  /** Remote-tracking branch names in an existing clone. */
  listBranches(cloneDir: string): Promise<string[]>;
}

export class GitOperationError extends Error {
  constructor(
    readonly kind: 'auth' | 'not_found' | 'network' | 'timeout' | 'invalid' | 'unknown',
    message: string,
  ) {
    super(message);
    this.name = 'GitOperationError';
  }
}
