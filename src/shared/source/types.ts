import type { SourceLanguage } from './paths';

/** API shapes of the source workspace, shared by the server and the editor UI. */

export type LockReason = 'secret' | 'binary' | 'too_large' | 'symlink' | 'submodule';

export interface TreeNodeView {
  path: string;
  kind: 'file' | 'symlink' | 'submodule';
  size: number;
  locked: LockReason | null;
  /** `modified`: draft of a committed file; `new`: draft of a file not in the commit. */
  draft: 'modified' | 'new' | null;
}

export interface DraftView {
  content: string;
  baseBlobSha: string | null;
  updatedAt: string;
  /** The committed file changed since the draft was started (or a "new" file now exists). */
  outdated: boolean;
}

export interface FileView {
  path: string;
  language: SourceLanguage;
  commitSha: string;
  /** Null when the file is not in the commit (a new-file draft). */
  blobSha: string | null;
  size: number;
  /** Committed content; null when locked or new. */
  content: string | null;
  editable: boolean;
  locked: LockReason | null;
  draft: DraftView | null;
}

export interface ChangeView {
  path: string;
  isNew: boolean;
  outdated: boolean;
  updatedAt: string;
  /** Content the draft was based on (null for new files or when it can no longer be read). */
  before: string | null;
  after: string;
}

export const LOCK_LABELS: Record<LockReason, string> = {
  secret: 'Secret file: contents are never shown or stored by stack-manager.',
  binary: 'Binary file: not editable here.',
  too_large: 'Larger than 1 MiB: not editable here.',
  symlink: 'Symbolic link: not followed or edited.',
  submodule: 'Git submodule: not editable here.',
};
