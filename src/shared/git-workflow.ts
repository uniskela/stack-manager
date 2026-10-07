/** Stable application contract for the Changes UI; never carries source or provider error text. */
export interface GitCommitRequest {
  paths: string[];
  message: string;
  push?: boolean;
  acknowledgeWarnings?: boolean;
}

export interface GitPushRequest {
  commitSha: string;
  expectedRemoteSha: string;
}

export interface GitWorkflowState {
  branch: string;
  localHeadSha: string;
  remoteHeadSha: string;
  ahead: number;
  behind: number;
}

export interface GitWorkflowProblem {
  path: string;
  line: number;
  column: number;
  severity: 'error' | 'warning' | 'info';
  code: 'source_error' | 'source_warning' | 'source_info' | 'hardcoded-secret';
}

export interface GitWorkflowResult {
  status:
    | 'ready'
    | 'commit_succeeded'
    | 'push_succeeded'
    | 'validation_blocked'
    | 'warnings_unacknowledged'
    | 'draft_outdated'
    | 'git_identity_missing'
    | 'remote_changed'
    | 'branch_changed'
    | 'push_rejected'
    | 'repository_busy'
    | 'git_operation_failed';
  repositoryId: string;
  branch: string;
  operation: 'inspect' | 'commit' | 'push';
  /** A successful commit made by this request (or the explicit SHA in a push request). */
  commitSha: string | null;
  /** Last successfully inspected heads; consult operation/status before using them for a push. */
  state: GitWorkflowState | null;
  problems: GitWorkflowProblem[];
  outdatedPaths: string[];
  /** Draft cleanup is deliberately manual in v0.5.0. */
  draftsPreserved: true;
  reason?:
    'auth' | 'not_found' | 'network' | 'timeout' | 'invalid' | 'conflict' | 'busy' | 'rejected' | 'unknown';
}
