import fs from 'node:fs';
import path from 'node:path';

export class PathEscapeError extends Error {
  constructor() {
    super('Path escapes its allowed root.');
    this.name = 'PathEscapeError';
  }
}

/**
 * Resolves a relative path inside `root`, rejecting absolute paths, `..` traversal, NUL bytes and
 * anything that normalises outside the root. Does not touch the filesystem.
 */
export function resolveWithin(root: string, relative: string): string {
  if (typeof relative !== 'string' || relative.length === 0 || relative.includes('\0'))
    throw new PathEscapeError();
  if (path.isAbsolute(relative) || /^[a-zA-Z]:[\\/]/.test(relative)) throw new PathEscapeError();
  const parts = relative.split(/[\\/]+/);
  if (parts.some((p) => p === '..')) throw new PathEscapeError();
  const base = path.resolve(root);
  const target = path.resolve(base, relative);
  if (target !== base && !target.startsWith(base + path.sep)) throw new PathEscapeError();
  return target;
}

/**
 * Like `resolveWithin`, then follows symlinks for the longest existing prefix and re-checks
 * containment, so a symlink inside a clone cannot point outside the data directory.
 */
export function resolveRealWithin(root: string, relative: string): string {
  const target = resolveWithin(root, relative);
  const realRoot = fs.realpathSync(path.resolve(root));
  let existing = target;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  const realExisting = fs.realpathSync(existing);
  const real = path.join(realExisting, path.relative(existing, target));
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw new PathEscapeError();
  return real;
}
