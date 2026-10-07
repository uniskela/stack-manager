/**
 * An unsaved-to-Git edit of one repository file. Drafts live in the database; the Git workflow commits
 * selected drafts but never deletes them. They are keyed by repository + path (not stack) because stacks may overlap.
 */
export interface SourceDraft {
  id: string;
  workspaceId: string;
  repositoryId: string;
  path: string;
  content: string;
  /** Blob the edit started from; null for a new file. Differs from the current blob → outdated. */
  baseBlobSha: string | null;
  /** Commit that was current when the draft was first created. */
  baseCommitSha: string;
  createdByUserId: string | null;
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Maximum size of an editable file / draft, in UTF-8 bytes. */
export const MAX_EDITABLE_BYTES = 1024 * 1024;
