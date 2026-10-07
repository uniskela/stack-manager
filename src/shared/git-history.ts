/** Plain text metadata and structured line hunks; clients must render strings as text. */
export interface HistoryFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'type_changed';
}

export interface HistoryCommit {
  sha: string;
  shortSha: string;
  parents: string[];
  subject: string;
  message: string;
  author: { name: string; email: string };
  authoredAt: string;
  committedAt: string;
  files: HistoryFile[];
  filesTruncated: boolean;
}

export interface HistoryPage {
  repositoryId: string;
  rootPath: string;
  headSha: string;
  commits: HistoryCommit[];
  nextCursor: string | null;
  historyLimitReached: boolean;
}

export interface HistoryFileDetail extends HistoryFile {
  locked:
    'secret' | 'symlink' | 'submodule' | 'binary' | 'too_large' | 'diff_limit' | 'unsupported_path' | null;
  /** null for locked files; empty for mode-only changes. Three lines of context. */
  hunks: Array<{
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: string[];
  }> | null;
}

export interface HistoryDetail {
  repositoryId: string;
  rootPath: string;
  headSha: string;
  commit: Omit<HistoryCommit, 'files'> & {
    files: HistoryFileDetail[];
    /** Merge diffs compare against the first parent; null means the empty tree. */
    diffBaseSha: string | null;
  };
}
