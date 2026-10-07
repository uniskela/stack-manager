/**
 * GitProvider capability interface (docs/providers/GIT_PROVIDER.md).
 *
 * Connection, source reads and isolated commit/push operations. Webhook
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

  /** Fetches and compares the retained local mutation head with the tracked remote branch. */
  inspectBranch(input: GitBranchInput): Promise<GitBranchState>;

  /** Creates a commit in an isolated worktree; never edits or deletes database drafts. */
  commit(input: GitCommitInput): Promise<GitCommitMetadata>;

  /** Pushes exactly the retained commit, after checking the freshly fetched remote head. No force. */
  push(input: GitPushInput): Promise<GitCommitMetadata>;

  getCommit(cloneDir: string, commitSha: string): Promise<GitCommitMetadata>;
}

export interface GitBranchInput {
  cloneDir: string;
  branch: string;
  /** Already host-policy checked by the application, as for syncClone. HTTPS without credentials. */
  remoteUrl: string;
  auth: GitHttpAuth | null;
  signal?: AbortSignal;
}

export interface GitBranchState {
  branch: string;
  localHeadSha: string;
  remoteHeadSha: string;
  ahead: number;
  behind: number;
}

export interface GitFileChange {
  /** Canonical repo-relative path; secret paths, symlinks and submodules are refused. */
  path: string;
  /** null deletes an existing file. */
  content: string | null;
  /** Expected current blob; null requires the path to be absent. Mirrors SourceDraft.baseBlobSha. */
  baseBlobSha: string | null;
}

export interface GitIdentity {
  name: string;
  email: string;
}

export interface GitCommitInput extends GitBranchInput {
  expectedHeadSha: string;
  changes: readonly GitFileChange[];
  message: string;
  author: GitIdentity;
}

export interface GitPushInput extends GitBranchInput {
  commitSha: string;
  expectedRemoteSha: string;
}

export interface GitCommitMetadata {
  sha: string;
  parents: string[];
  message: string;
  author: GitIdentity;
  committer: GitIdentity;
  authoredAt: string;
  committedAt: string;
}

export class GitOperationError extends Error {
  constructor(
    readonly kind:
      'auth' | 'not_found' | 'network' | 'timeout' | 'invalid' | 'conflict' | 'busy' | 'rejected' | 'unknown',
    message: string,
  ) {
    super(message);
    this.name = 'GitOperationError';
  }
}

/** One entry of a commit's tree (`git ls-tree -r -l`). */
export interface SourceTreeEntry {
  /** Repo-relative POSIX path. */
  path: string;
  kind: 'file' | 'symlink' | 'submodule';
  executable: boolean;
  /** Blob (or commit, for submodules) object id. */
  objectSha: string;
  /** Bytes; 0 for submodules. */
  size: number;
}

/**
 * Read-only access to committed content of a local clone. Reads Git objects directly, never the
 * working tree, so symlinks and checkout state on disk cannot influence what is served.
 */
export interface SourceTreeReader {
  /** Full tree of a commit. Throws GitOperationError('invalid') if the commit is unknown or too large. */
  listTree(cloneDir: string, commitSha: string): Promise<SourceTreeEntry[]>;
  /** Blob contents decoded as UTF-8. */
  readBlob(cloneDir: string, blobSha: string): Promise<string>;
}
