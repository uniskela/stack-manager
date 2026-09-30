import { describe, expect, it } from 'vitest';
import { filterStacks, folderSegment, groupStacks } from '@/shared/stacks/group-stacks';

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
});
