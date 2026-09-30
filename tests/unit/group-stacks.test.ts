import { describe, expect, it } from 'vitest';
import { filterStacks, folderSegment, groupStacks, stackCountLabel } from '@/shared/stacks/group-stacks';

const stacks = [
  {
    id: '1',
    name: 'apprise',
    rootPath: '100-casaos/apprise',
    draftCount: 0,
    repository: { id: 'r1', name: 'infra' },
  },
  {
    id: '2',
    name: 'rooty',
    rootPath: '',
    draftCount: 1,
    repository: { id: 'r1', name: 'infra' },
  },
  {
    id: '3',
    name: 'alpha',
    rootPath: '200-apps/alpha',
    draftCount: 0,
    repository: { id: 'r2', name: 'apps' },
  },
];

describe('folderSegment', () => {
  it('uses first path segment or repository-root label', () => {
    expect(folderSegment('100-casaos/apprise')).toBe('100-casaos');
    expect(folderSegment('')).toBe('(repository root)');
    expect(folderSegment('single')).toBe('single');
  });
});

describe('groupStacks', () => {
  it('groups by repository name then folder, sorted stably', () => {
    const groups = groupStacks(stacks);
    expect(groups.map((g) => g.repositoryName)).toEqual(['apps', 'infra']);
    const infra = groups.find((g) => g.repositoryId === 'r1')!;
    expect(infra.folders.map((f) => f.segment)).toEqual(['(repository root)', '100-casaos']);
    expect(infra.folders[1]!.stacks.map((s) => s.name)).toEqual(['apprise']);
  });
});

describe('groupStacks natural order', () => {
  const stack = (id: string, name: string, rootPath: string, repo = 'r1', repoName = 'homelab') => ({
    id,
    name,
    rootPath,
    repository: { id: repo, name: repoName },
  });

  it('orders numbered folders and names the way a person reads them', () => {
    const groups = groupStacks([
      stack('a', 'x', '100-casaos/x'),
      stack('b', 'y', '20-media/y'),
      stack('c', 'z', '3-network/z'),
      stack('d', 'stack10', '10-core/stack10'),
      stack('e', 'stack2', '10-core/stack2'),
      stack('f', 'stack1', '10-core/stack1'),
    ]);
    const folders = groups[0]!.folders;
    expect(folders.map((f) => f.segment)).toEqual(['3-network', '10-core', '20-media', '100-casaos']);
    expect(folders[1]!.stacks.map((s) => s.name)).toEqual(['stack1', 'stack2', 'stack10']);
  });

  it('orders repositories naturally and case-insensitively', () => {
    const groups = groupStacks([
      stack('a', 'a', 'a', 'r10', 'lab10'),
      stack('b', 'b', 'b', 'r2', 'lab2'),
      stack('c', 'c', 'c', 'r3', 'Apps'),
    ]);
    expect(groups.map((g) => g.repositoryName)).toEqual(['Apps', 'lab2', 'lab10']);
  });

  it('keeps the repository root first even when a folder sorts before "("', () => {
    const groups = groupStacks([stack('a', 'a', '!special/a'), stack('b', 'root', '')]);
    expect(groups[0]!.folders.map((f) => f.segment)).toEqual(['(repository root)', '!special']);
  });

  it('breaks name ties by path so equal names keep a stable order', () => {
    const groups = groupStacks([stack('a', 'Plex', 'media/plex-b'), stack('b', 'plex', 'media/plex-a')]);
    expect(groups[0]!.folders[0]!.stacks.map((s) => s.rootPath)).toEqual(['media/plex-a', 'media/plex-b']);
  });
});

describe('filterStacks', () => {
  it('matches name, repository name, and full rootPath', () => {
    expect(filterStacks(stacks, 'casaos').map((s) => s.id)).toEqual(['1']);
    expect(
      filterStacks(stacks, 'INFRA')
        .map((s) => s.id)
        .sort(),
    ).toEqual(['1', '2']);
    expect(filterStacks(stacks, 'nope')).toEqual([]);
  });

  it('requires every term, across fields', () => {
    expect(filterStacks(stacks, '  infra   apprise ').map((s) => s.id)).toEqual(['1']);
    expect(filterStacks(stacks, 'apps apprise')).toEqual([]);
    expect(filterStacks(stacks, '   ')).toEqual(stacks);
  });
});

describe('stackCountLabel', () => {
  it('shows the total, or shown of total while filtering', () => {
    expect(stackCountLabel(87, 87)).toBe('87 stacks');
    expect(stackCountLabel(1, 1)).toBe('1 stack');
    expect(stackCountLabel(12, 87)).toBe('12 of 87 stacks');
    expect(stackCountLabel(0, 87)).toBe('0 of 87 stacks');
  });
});
