import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveRealWithin } from '@/server/security/paths';
import { GitOperationError } from './types';

/** Shared by fetch, commit and push, including different providers/processes using the data volume. */
export async function resolveRepositoryDir(reposDir: string, cloneDir: string): Promise<string> {
  const root = await fs.realpath(reposDir);
  const dir = path.resolve(cloneDir);
  if (path.dirname(dir) !== path.resolve(reposDir) || path.basename(dir).startsWith('.')) {
    throw new GitOperationError('invalid', 'Clone path is outside the repositories directory.');
  }
  const canonical = resolveRealWithin(root, path.basename(dir));
  if (canonical !== path.join(root, path.basename(dir))) {
    throw new GitOperationError('invalid', 'Symlinked clone directories are not supported.');
  }
  // Do not accept worktree gitdir indirections or symlinked metadata as an application clone.
  const stat = await fs.lstat(path.join(canonical, '.git')).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (stat && !stat.isDirectory()) {
    throw new GitOperationError('invalid', 'The clone must have its own Git directory.');
  }
  return canonical;
}

export async function withRepositoryLock<T>(
  reposDir: string,
  cloneDir: string,
  operation: (dir: string) => Promise<T>,
): Promise<T> {
  const canonical = await resolveRepositoryDir(reposDir, cloneDir);
  const root = path.dirname(canonical);
  const dir = canonical;
  const lockPath = path.join(root, `.lock-${path.basename(dir)}`);
  let lock;
  try {
    lock = await fs.open(lockPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new GitOperationError('busy', 'Another Git operation is in progress for this repository.');
    }
    throw error;
  }
  try {
    return await operation(canonical);
  } finally {
    await lock.close();
    await fs.unlink(lockPath);
  }
}
