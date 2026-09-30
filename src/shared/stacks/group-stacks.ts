export type GroupableStack = {
  id: string;
  name: string;
  rootPath: string;
  draftCount?: number;
  repository: { id: string; name: string };
};

export type StackFolderGroup<T extends GroupableStack = GroupableStack> = {
  segment: string;
  stacks: T[];
};

export type StackRepoGroup<T extends GroupableStack = GroupableStack> = {
  repositoryId: string;
  repositoryName: string;
  folders: StackFolderGroup<T>[];
};

export const REPOSITORY_ROOT_SEGMENT = '(repository root)';

/** Natural order, as a person reads it: `stack2` before `stack10`, `20-media` before `100-casaos`, case-insensitive. */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function naturalCompare(a: string, b: string): number {
  return collator.compare(a, b);
}

export function folderSegment(rootPath: string): string {
  const trimmed = rootPath.replace(/^\/+|\/+$/g, '');
  if (!trimmed) return REPOSITORY_ROOT_SEGMENT;
  return trimmed.split('/')[0] ?? REPOSITORY_ROOT_SEGMENT;
}

/** Every whitespace-separated term must appear in the stack name, repository name or full `rootPath`. */
export function filterStacks<T extends GroupableStack>(stacks: T[], query: string): T[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return stacks;
  return stacks.filter((s) => {
    const haystack = `${s.name}\n${s.repository.name}\n${s.rootPath}`.toLowerCase();
    return terms.every((t) => haystack.includes(t));
  });
}

/** "12 of 87 stacks" while filtering, "87 stacks" otherwise. */
export function stackCountLabel(shown: number, total: number): string {
  const noun = total === 1 ? 'stack' : 'stacks';
  return shown === total ? `${total} ${noun}` : `${shown} of ${total} ${noun}`;
}

/** Repository root first, then natural order. */
function compareSegments(a: string, b: string): number {
  if (a === b) return 0;
  if (a === REPOSITORY_ROOT_SEGMENT) return -1;
  if (b === REPOSITORY_ROOT_SEGMENT) return 1;
  return naturalCompare(a, b);
}

/**
 * Repository (natural name order, then id) → first path segment (root first, then natural order) → stack
 * (natural name order, then path and id so equal names never swap between renders).
 */
export function groupStacks<T extends GroupableStack>(stacks: T[]): StackRepoGroup<T>[] {
  const byRepo = new Map<string, { name: string; stacks: T[] }>();
  for (const s of stacks) {
    const cur = byRepo.get(s.repository.id) ?? { name: s.repository.name, stacks: [] };
    cur.stacks.push(s);
    byRepo.set(s.repository.id, cur);
  }
  const repos = [...byRepo.entries()].sort(
    (a, b) => naturalCompare(a[1].name, b[1].name) || a[0].localeCompare(b[0]),
  );
  return repos.map(([repositoryId, { name: repositoryName, stacks: repoStacks }]) => {
    const byFolder = new Map<string, T[]>();
    for (const s of repoStacks) {
      const seg = folderSegment(s.rootPath);
      const list = byFolder.get(seg) ?? [];
      list.push(s);
      byFolder.set(seg, list);
    }
    const folders = [...byFolder.entries()]
      .sort(([a], [b]) => compareSegments(a, b))
      .map(([segment, folderStacks]) => ({
        segment,
        stacks: [...folderStacks].sort(
          (x, y) =>
            naturalCompare(x.name, y.name) ||
            naturalCompare(x.rootPath, y.rootPath) ||
            x.id.localeCompare(y.id),
        ),
      }));
    return { repositoryId, repositoryName, folders };
  });
}
