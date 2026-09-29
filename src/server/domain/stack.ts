import { normalizeRepoPath, RepoPathError } from '@/shared/source/paths';
import { ValidationError } from './errors';
import { slugify } from './workspace';

/**
 * An explicit stack: a directory in a repository plus its primary Compose file
 * (docs/STACK_DISCOVERY.md). Identity is this record, never a folder-name heuristic.
 */
export interface Stack {
  id: string;
  workspaceId: string;
  repositoryId: string;
  name: string;
  /** Stable key for later routing/bindings; unique per repository. */
  slug: string;
  /** Repo-relative directory; `''` is the repository root. */
  rootPath: string;
  /** Repo-relative path of the primary Compose file (inside `rootPath`). */
  composePath: string;
  createdAt: Date;
  updatedAt: Date;
}

export function validateStackName(input: string): string {
  const name = input.trim().replace(/\s+/g, ' ');
  if (name.length < 1 || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new ValidationError('Invalid stack name.', { name: 'Use 1–80 printable characters.' });
  }
  return name;
}

export function stackSlug(name: string): string {
  const slug = slugify(name);
  return slug === 'workspace' ? 'stack' : slug;
}

/** Normalises a repo path for a request field, mapping path errors to field-level validation errors. */
export function repoPathField(input: string, field: string, options?: { allowRoot?: boolean }): string {
  try {
    return normalizeRepoPath(input, options);
  } catch (error) {
    if (error instanceof RepoPathError)
      throw new ValidationError('Invalid path.', { [field]: error.message });
    throw error;
  }
}

/** Suggested display name for a stack directory: "apps/wiki" → "wiki", root → repository name. */
export function stackNameFromRoot(rootPath: string, fallback: string): string {
  const last = rootPath.split('/').filter(Boolean).pop();
  return last ?? fallback;
}
