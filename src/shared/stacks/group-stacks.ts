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

export function folderSegment(rootPath: string): string {
  const trimmed = rootPath.replace(/^\/+|\/+$/g, '');
  if (!trimmed) return '(repository root)';
  return trimmed.split('/')[0] ?? '(repository root)';
}

export function filterStacks<T extends GroupableStack>(stacks: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return stacks;
  return stacks.filter(
    (s) =>
      s.name.toLowerCase().includes(q) ||
      s.repository.name.toLowerCase().includes(q) ||
      s.rootPath.toLowerCase().includes(q),
  );
}

export function groupStacks<T extends GroupableStack>(stacks: T[]): StackRepoGroup<T>[] {
  const byRepo = new Map<string, { name: string; stacks: T[] }>();
  for (const s of stacks) {
    const cur = byRepo.get(s.repository.id) ?? { name: s.repository.name, stacks: [] };
    cur.stacks.push(s);
    byRepo.set(s.repository.id, cur);
  }
  const repos = [...byRepo.entries()].sort((a, b) => {
    const byName = a[1].name.localeCompare(b[1].name);
    return byName !== 0 ? byName : a[0].localeCompare(b[0]);
  });
  return repos.map(([repositoryId, { name: repositoryName, stacks: repoStacks }]) => {
    const byFolder = new Map<string, T[]>();
    for (const s of repoStacks) {
      const seg = folderSegment(s.rootPath);
      const list = byFolder.get(seg) ?? [];
      list.push(s);
      byFolder.set(seg, list);
    }
    const folders = [...byFolder.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([segment, folderStacks]) => ({
        segment,
        stacks: [...folderStacks].sort((x, y) => x.name.localeCompare(y.name)),
      }));
    return { repositoryId, repositoryName, folders };
  });
}
