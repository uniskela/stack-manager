import { filterStacks, naturalCompare, type GroupableRepository, type GroupableStack } from './group-stacks';

/**
 * Stacks list view state, kept in the URL (`?q=&drafts=1&attention=1&repo=&sort=&group=`) so Back, reload and a
 * pasted link reproduce the same view. Only non-default values are written.
 */
export type StackSort = 'name' | 'path' | 'drafts';
export type StackGrouping = 'folder' | 'repository' | 'none';

export interface StackListState {
  q: string;
  /** Only stacks with drafts. */
  drafts: boolean;
  /** Only stacks whose repository failed to sync or has never been fetched. */
  attention: boolean;
  /** Only this repository id. */
  repo: string | null;
  sort: StackSort;
  group: StackGrouping;
}

export const DEFAULT_STACK_LIST_STATE: StackListState = Object.freeze({
  q: '',
  drafts: false,
  attention: false,
  repo: null,
  sort: 'name',
  group: 'folder',
});

export const STACK_SORTS: readonly { value: StackSort; label: string }[] = [
  { value: 'name', label: 'Name' },
  { value: 'path', label: 'Path' },
  { value: 'drafts', label: 'Most drafts' },
];

export const STACK_GROUPINGS: readonly { value: StackGrouping; label: string }[] = [
  { value: 'folder', label: 'Folder' },
  { value: 'repository', label: 'Repository' },
  { value: 'none', label: 'None' },
];

const MAX_QUERY_LENGTH = 200;

function oneOf<T extends string>(value: string | null, allowed: readonly { value: T }[], fallback: T): T {
  return allowed.find((a) => a.value === value)?.value ?? fallback;
}

/** Reads the state from URL parameters. Unknown or malformed values fall back to the defaults. */
export function parseStackListState(params: { get(name: string): string | null }): StackListState {
  return {
    q: (params.get('q') ?? '').slice(0, MAX_QUERY_LENGTH),
    drafts: params.get('drafts') === '1',
    attention: params.get('attention') === '1',
    repo: params.get('repo') || null,
    sort: oneOf(params.get('sort'), STACK_SORTS, 'name'),
    group: oneOf(params.get('group'), STACK_GROUPINGS, 'folder'),
  };
}

/** URL query string (no leading `?`) holding only the values that differ from the defaults, in a stable order. */
export function serialiseStackListState(state: StackListState): string {
  const params = new URLSearchParams();
  if (state.q.trim()) params.set('q', state.q);
  if (state.drafts) params.set('drafts', '1');
  if (state.attention) params.set('attention', '1');
  if (state.repo) params.set('repo', state.repo);
  if (state.sort !== 'name') params.set('sort', state.sort);
  if (state.group !== 'folder') params.set('group', state.group);
  return params.toString();
}

/** Number of active filters (search excluded), for the mobile "Filters" button. */
export function activeFilterCount(state: StackListState): number {
  return Number(state.drafts) + Number(state.attention) + Number(state.repo !== null);
}

/** True when anything narrows the list (search or a filter); sort and grouping don't. */
export function isNarrowed(state: StackListState): boolean {
  return state.q.trim() !== '' || activeFilterCount(state) > 0;
}

/** Key identifying what narrows the list, so collapse toggles made while narrowed reset when it changes. */
export function narrowingKey(state: StackListState): string {
  return JSON.stringify([state.q.trim(), state.drafts, state.attention, state.repo]);
}

/** A repository that needs the operator: its last fetch failed, or it has never been fetched. */
export function needsAttention(repository: GroupableRepository): boolean {
  return repository.syncStatus === 'error' || repository.fetched === false;
}

export function applyStackFilters<T extends GroupableStack>(stacks: T[], state: StackListState): T[] {
  return filterStacks(stacks, state.q).filter(
    (s) =>
      (!state.drafts || (s.draftCount ?? 0) > 0) &&
      (!state.attention || needsAttention(s.repository)) &&
      (state.repo === null || s.repository.id === state.repo),
  );
}

/** Comparator for stacks in the chosen order; ties fall back to name, repository, path and id so order is stable. */
export function stackComparator(sort: StackSort): (a: GroupableStack, b: GroupableStack) => number {
  const byName = (a: GroupableStack, b: GroupableStack) =>
    naturalCompare(a.name, b.name) ||
    naturalCompare(a.repository.name, b.repository.name) ||
    naturalCompare(a.rootPath, b.rootPath) ||
    a.id.localeCompare(b.id);
  switch (sort) {
    case 'path':
      return (a, b) => naturalCompare(a.rootPath, b.rootPath) || byName(a, b);
    case 'drafts':
      return (a, b) => (b.draftCount ?? 0) - (a.draftCount ?? 0) || byName(a, b);
    case 'name':
      return byName;
  }
}

export type TextPart = { text: string; match: boolean };

/** Splits text into parts, marking case-insensitive occurrences of any search term (for `<mark>`). */
export function highlightParts(text: string, query: string): TextPart[] {
  const terms = [...new Set(query.trim().toLowerCase().split(/\s+/).filter(Boolean))];
  if (terms.length === 0 || !text) return [{ text, match: false }];
  const lower = text.toLowerCase();
  const marked = new Array<boolean>(text.length).fill(false);
  for (const term of terms) {
    for (let i = lower.indexOf(term); i !== -1; i = lower.indexOf(term, i + 1)) {
      marked.fill(true, i, i + term.length);
    }
  }
  const parts: TextPart[] = [];
  for (let i = 0; i < text.length; i++) {
    const last = parts.at(-1);
    if (last && last.match === marked[i]) last.text += text[i];
    else parts.push({ text: text[i]!, match: marked[i]! });
  }
  return parts;
}
