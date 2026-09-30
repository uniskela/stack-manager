import { describe, expect, it } from 'vitest';
import { groupStacks } from '@/shared/stacks/group-stacks';
import {
  activeFilterCount,
  applyStackFilters,
  DEFAULT_STACK_LIST_STATE,
  highlightParts,
  isNarrowed,
  narrowingKey,
  needsAttention,
  parseStackListState,
  serialiseStackListState,
  stackComparator,
  type StackListState,
} from '@/shared/stacks/list-state';

const ready = { id: 'r1', name: 'homelab', syncStatus: 'ready', fetched: true };
const broken = { id: 'r2', name: 'legacy', syncStatus: 'error', fetched: false };
const stacks = [
  { id: 'a', name: 'plex', rootPath: '20-media/plex', draftCount: 2, repository: ready },
  { id: 'b', name: 'sonarr', rootPath: '20-media/sonarr', draftCount: 0, repository: ready },
  { id: 'c', name: 'traefik', rootPath: '10-core/traefik', draftCount: 1, repository: ready },
  { id: 'd', name: 'ghost', rootPath: 'sites/ghost', draftCount: 0, repository: broken },
];

const state = (patch: Partial<StackListState>): StackListState => ({ ...DEFAULT_STACK_LIST_STATE, ...patch });

describe('parse and serialise', () => {
  it('round-trips every value and omits defaults', () => {
    const full = state({
      q: 'media plex',
      drafts: true,
      attention: true,
      repo: 'r1',
      sort: 'drafts',
      group: 'none',
    });
    const qs = serialiseStackListState(full);
    expect(qs).toBe('q=media+plex&drafts=1&attention=1&repo=r1&sort=drafts&group=none');
    expect(parseStackListState(new URLSearchParams(qs))).toEqual(full);
    expect(serialiseStackListState(DEFAULT_STACK_LIST_STATE)).toBe('');
    expect(serialiseStackListState(state({ q: '   ' }))).toBe('');
  });

  it('falls back to defaults for unknown or malformed values', () => {
    const parsed = parseStackListState(
      new URLSearchParams('sort=size&group=tree&drafts=yes&attention=true&repo=&q=' + 'x'.repeat(500)),
    );
    expect(parsed).toEqual(state({ q: 'x'.repeat(200) }));
  });
});

describe('filters', () => {
  it('combines search, drafts, attention and repository', () => {
    const ids = (s: StackListState) => applyStackFilters(stacks, s).map((x) => x.id);
    expect(ids(state({}))).toEqual(['a', 'b', 'c', 'd']);
    expect(ids(state({ drafts: true }))).toEqual(['a', 'c']);
    expect(ids(state({ attention: true }))).toEqual(['d']);
    expect(ids(state({ repo: 'r1' }))).toEqual(['a', 'b', 'c']);
    expect(ids(state({ q: 'media', drafts: true }))).toEqual(['a']);
    expect(ids(state({ repo: 'r2', drafts: true }))).toEqual([]);
  });

  it('counts active filters and knows when the list is narrowed', () => {
    expect(activeFilterCount(state({ drafts: true, repo: 'r1' }))).toBe(2);
    expect(isNarrowed(state({ sort: 'path', group: 'none' }))).toBe(false);
    expect(isNarrowed(state({ q: ' x ' }))).toBe(true);
    expect(isNarrowed(state({ attention: true }))).toBe(true);
    expect(narrowingKey(state({ q: 'x ', sort: 'path' }))).toBe(narrowingKey(state({ q: 'x' })));
  });

  it('flags repositories that failed or were never fetched', () => {
    expect(needsAttention(ready)).toBe(false);
    expect(needsAttention({ id: 'x', name: 'x', syncStatus: 'error', fetched: true })).toBe(true);
    expect(needsAttention({ id: 'x', name: 'x', syncStatus: 'pending', fetched: false })).toBe(true);
    expect(needsAttention({ id: 'x', name: 'x' })).toBe(false);
  });
});

describe('sort', () => {
  const order = (sort: 'name' | 'path' | 'drafts') =>
    [...stacks].sort(stackComparator(sort)).map((s) => s.name);

  it('orders by name, path or most drafts with stable ties', () => {
    expect(order('name')).toEqual(['ghost', 'plex', 'sonarr', 'traefik']);
    expect(order('path')).toEqual(['traefik', 'plex', 'sonarr', 'ghost']);
    expect(order('drafts')).toEqual(['plex', 'traefik', 'ghost', 'sonarr']);
  });

  it('applies inside folder groups, keeping the whole-repository stack first', () => {
    const root = { id: 'z', name: 'zz', rootPath: '', draftCount: 0, repository: ready };
    const top = { id: 'y', name: 'busy', rootPath: 'busy', draftCount: 5, repository: ready };
    const groups = groupStacks([top, root], stackComparator('drafts'));
    expect(groups[0]!.folders[0]!.stacks.map((s) => s.id)).toEqual(['z', 'y']);
  });
});

describe('highlightParts', () => {
  it('marks every term case-insensitively and merges overlaps', () => {
    expect(highlightParts('Plex-media', 'media PLEX')).toEqual([
      { text: 'Plex', match: true },
      { text: '-', match: false },
      { text: 'media', match: true },
    ]);
    expect(highlightParts('aaa', 'aa')).toEqual([{ text: 'aaa', match: true }]);
    expect(highlightParts('sonarr', '')).toEqual([{ text: 'sonarr', match: false }]);
    expect(highlightParts('sonarr', 'plex')).toEqual([{ text: 'sonarr', match: false }]);
  });
});
