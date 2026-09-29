import 'server-only';
import { isMarkdownPath, joinRepoPath, normalizeRepoPath, relativeTo } from '@/shared/source/paths';
import type { TreeNodeView } from '@/shared/source/types';

/** Root README first, then other root pages, then each folder in path order with its README first. */
export function docOrder(root: string) {
  const key = (p: string) => {
    const rel = relativeTo(root, p);
    const slash = rel.lastIndexOf('/');
    const dir = slash === -1 ? '' : rel.slice(0, slash);
    const name = rel.slice(slash + 1);
    return { nested: dir ? 1 : 0, dir, readme: /^readme\.md$/i.test(name) ? 0 : 1, name };
  };
  return (a: string, b: string) => {
    const x = key(a);
    const y = key(b);
    return (
      x.nested - y.nested || x.dir.localeCompare(y.dir) || x.readme - y.readme || x.name.localeCompare(y.name)
    );
  };
}

/** Readable Markdown files of a scope, in reading order. */
export function markdownDocs(entries: TreeNodeView[], root: string): TreeNodeView[] {
  return entries
    .filter((e) => e.kind === 'file' && !e.locked && isMarkdownPath(e.path))
    .sort((a, b) => docOrder(root)(a.path, b.path));
}

/**
 * Resolves a `?file=` / `?doc=` value (relative to `root`) to a repository path that `allowed` accepts,
 * or null for a missing or malformed value.
 */
export function resolveRequested(
  root: string,
  requested: string | string[] | undefined,
  allowed: (path: string) => boolean,
): string | null {
  if (typeof requested !== 'string' || !requested) return null;
  try {
    const candidate = normalizeRepoPath(joinRepoPath(root, normalizeRepoPath(requested)));
    return allowed(candidate) ? candidate : null;
  } catch {
    return null;
  }
}
