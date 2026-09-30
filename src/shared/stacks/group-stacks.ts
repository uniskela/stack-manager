export type GroupableRepository = {
  id: string;
  name: string;
  /** Repository sync status (`pending | syncing | ready | error`); omitted means ready. */
  syncStatus?: string;
  /** False until the first successful fetch. Omitted means fetched. */
  fetched?: boolean;
  /** Drafts anywhere in the repository, inside a stack or not. */
  draftCount?: number;
};

export type GroupableStack = {
  id: string;
  name: string;
  rootPath: string;
  draftCount?: number;
  repository: GroupableRepository;
};

export type StackFolderGroup<T extends GroupableStack = GroupableStack> = {
  /** Parent directory of the group's stacks; `''` is the repository root. */
  path: string;
  stacks: T[];
};

export type StackRepoGroup<T extends GroupableStack = GroupableStack> = {
  repositoryId: string;
  repositoryName: string;
  repository: T['repository'];
  stackCount: number;
  folders: StackFolderGroup<T>[];
};

export const REPOSITORY_ROOT_LABEL = 'Repository root';

/** Natural order, as a person reads it: `stack2` before `stack10`, `20-media` before `100-casaos`, case-insensitive. */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function naturalCompare(a: string, b: string): number {
  return collator.compare(a, b);
}

function trimSlashes(path: string): string {
  return path.replace(/^\/+|\/+$/g, '');
}

/** Directory that contains a stack's folder: `apps/media/plex` → `apps/media`; top-level folders and the root → `''`. */
export function parentFolder(rootPath: string): string {
  const trimmed = trimSlashes(rootPath);
  const slash = trimmed.lastIndexOf('/');
  return slash === -1 ? '' : trimmed.slice(0, slash);
}

/** Last segment of a stack's folder (`apps/media/plex` → `plex`), or `''` for the repository root. */
export function folderName(rootPath: string): string {
  const trimmed = trimSlashes(rootPath);
  return trimmed.slice(trimmed.lastIndexOf('/') + 1);
}

/** Label for a folder group header. */
export function folderLabel(path: string): string {
  return path || REPOSITORY_ROOT_LABEL;
}

/**
 * Secondary text for a stack row, or null when the name already says it. The group header shows the parent folder,
 * so a row only needs its own folder name when the stack was renamed, and a hint when it covers the whole repository.
 */
export function stackRowDetail(stack: Pick<GroupableStack, 'name' | 'rootPath'>): string | null {
  const own = folderName(stack.rootPath);
  if (!own) return 'Whole repository';
  return naturalCompare(own, stack.name) === 0 ? null : `${own}/`;
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

export function pluralise(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** Repository root first, then natural path order (so `apps/home`, `apps/media`, `infra` sit together). */
function compareFolders(a: string, b: string): number {
  if (a === b) return 0;
  if (a === '') return -1;
  if (b === '') return 1;
  return naturalCompare(a, b);
}

/**
 * Repository (natural name order, then id) → parent folder (root first, then natural path order) → stack
 * (whole-repository stack first, then natural name order, then path and id so equal names never swap).
 */
export function groupStacks<T extends GroupableStack>(
  stacks: T[],
  /** Order of stacks inside a folder (default: natural name order). The whole-repository stack still leads. */
  compare?: (a: T, b: T) => number,
): StackRepoGroup<T>[] {
  const byRepo = new Map<string, { repository: T['repository']; stacks: T[] }>();
  for (const s of stacks) {
    const cur = byRepo.get(s.repository.id) ?? { repository: s.repository, stacks: [] as T[] };
    cur.stacks.push(s);
    byRepo.set(s.repository.id, cur);
  }
  const repos = [...byRepo.entries()].sort(
    (a, b) => naturalCompare(a[1].repository.name, b[1].repository.name) || a[0].localeCompare(b[0]),
  );
  return repos.map(([repositoryId, { repository, stacks: repoStacks }]) => {
    const byFolder = new Map<string, T[]>();
    for (const s of repoStacks) {
      const path = parentFolder(s.rootPath);
      const list = byFolder.get(path) ?? [];
      list.push(s);
      byFolder.set(path, list);
    }
    const folders = [...byFolder.entries()]
      .sort(([a], [b]) => compareFolders(a, b))
      .map(([path, folderStacks]) => ({
        path,
        stacks: [...folderStacks].sort(
          (x, y) =>
            // A stack covering the whole repository leads the root group.
            Number(y.rootPath === '') - Number(x.rootPath === '') ||
            (compare
              ? compare(x, y)
              : naturalCompare(x.name, y.name) ||
                naturalCompare(x.rootPath, y.rootPath) ||
                x.id.localeCompare(y.id)),
        ),
      }));
    return {
      repositoryId,
      repositoryName: repository.name,
      repository,
      stackCount: repoStacks.length,
      folders,
    };
  });
}
