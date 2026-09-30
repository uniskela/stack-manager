import { describe, expect, it } from 'vitest';
import {
  filterStacks,
  folderLabel,
  folderName,
  groupStacks,
  parentFolder,
  pluralise,
  stackCountLabel,
  stackRowDetail,
} from '@/shared/stacks/group-stacks';

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

describe('folder helpers', () => {
  it('finds the parent folder, own folder name and group label', () => {
    expect(parentFolder('apps/media/plex')).toBe('apps/media');
    expect(parentFolder('100-casaos/apprise')).toBe('100-casaos');
    expect(parentFolder('caddy')).toBe('');
    expect(parentFolder('')).toBe('');
    expect(parentFolder('/apps/media/')).toBe('apps');
    expect(folderName('apps/media/plex')).toBe('plex');
    expect(folderName('')).toBe('');
    expect(folderLabel('')).toBe('Repository root');
    expect(folderLabel('apps/media')).toBe('apps/media');
  });

  it('only adds row detail when the name does not already say it', () => {
    expect(stackRowDetail({ name: 'plex', rootPath: 'apps/media/plex' })).toBeNull();
    expect(stackRowDetail({ name: 'Plex', rootPath: 'apps/media/plex' })).toBeNull();
    expect(stackRowDetail({ name: 'Media server', rootPath: 'apps/media/plex' })).toBe('plex/');
    expect(stackRowDetail({ name: 'homelab', rootPath: '' })).toBe('Whole repository');
  });
});

describe('groupStacks', () => {
  it('groups by repository name then parent folder, sorted stably', () => {
    const groups = groupStacks(stacks);
    expect(groups.map((g) => g.repositoryName)).toEqual(['apps', 'infra']);
    const infra = groups.find((g) => g.repositoryId === 'r1')!;
    expect(infra.stackCount).toBe(2);
    expect(infra.repository).toEqual({ id: 'r1', name: 'infra' });
    expect(infra.folders.map((f) => f.path)).toEqual(['', '100-casaos']);
    expect(infra.folders[1]!.stacks.map((s) => s.name)).toEqual(['apprise']);
  });

  it('keeps nested folders apart and adjacent in path order', () => {
    const stack = (id: string, rootPath: string) => ({
      id,
      name: rootPath.split('/').pop()!,
      rootPath,
      repository: { id: 'r', name: 'mono' },
    });
    const groups = groupStacks([
      stack('1', 'services/auth/vault'),
      stack('2', 'apps/media/plex'),
      stack('3', 'services/mail'),
      stack('4', 'apps/home/esphome'),
      stack('5', 'caddy'),
    ]);
    expect(groups[0]!.folders.map((f) => f.path)).toEqual([
      '',
      'apps/home',
      'apps/media',
      'services',
      'services/auth',
    ]);
  });

  it('puts the whole-repository stack first in the root group', () => {
    const groups = groupStacks([
      { id: 'a', name: 'alpha', rootPath: 'alpha', repository: { id: 'r', name: 'x' } },
      { id: 'z', name: 'zeta', rootPath: '', repository: { id: 'r', name: 'x' } },
    ]);
    expect(groups[0]!.folders[0]!.stacks.map((s) => s.id)).toEqual(['z', 'a']);
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
    expect(folders.map((f) => f.path)).toEqual(['3-network', '10-core', '20-media', '100-casaos']);
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

  it('keeps the repository root first even when a folder sorts before it', () => {
    const groups = groupStacks([stack('a', 'a', '!special/a'), stack('b', 'root', '')]);
    expect(groups[0]!.folders.map((f) => f.path)).toEqual(['', '!special']);
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

describe('pluralise', () => {
  it('adds an s except for one', () => {
    expect(pluralise(0, 'draft')).toBe('0 drafts');
    expect(pluralise(1, 'draft')).toBe('1 draft');
    expect(pluralise(3, 'stack')).toBe('3 stacks');
  });
});
