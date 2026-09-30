'use client';

import { ChevronDown, ChevronRight, Layers, Search, SearchX, X } from 'lucide-react';
import Link from 'next/link';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import {
  filterStacks,
  groupStacks,
  stackCountLabel,
  type GroupableStack,
} from '@/shared/stacks/group-stacks';
import { Button } from '@/ui/primitives/button';
import { EmptyState } from '@/ui/primitives/empty-state';

function collapseStorageKey(workspaceId: string): string {
  return `sm.stacks.collapse.${workspaceId}`;
}

const collapseListeners = new Set<() => void>();

/** Stable empty snapshot for useSyncExternalStore when storage is missing or invalid. */
const EMPTY_COLLAPSE_MAP: Record<string, boolean> = Object.freeze({});

const collapseMapCache = new Map<string, { raw: string | null; snapshot: Record<string, boolean> }>();

function notifyCollapseListeners(): void {
  for (const listener of collapseListeners) {
    listener();
  }
}

function readCollapseMap(workspaceId: string): Record<string, boolean> {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(collapseStorageKey(workspaceId));
  } catch {
    // Storage unavailable — keep toggles working via the in-memory snapshot.
    return collapseMapCache.get(workspaceId)?.snapshot ?? EMPTY_COLLAPSE_MAP;
  }

  const cached = collapseMapCache.get(workspaceId);
  if (cached !== undefined && cached.raw === raw) {
    return cached.snapshot;
  }

  if (!raw) {
    // After a failed persist we cache { raw: null, snapshot }; keep that so toggles stick.
    if (cached !== undefined && cached.raw === null && cached.snapshot !== EMPTY_COLLAPSE_MAP) {
      return cached.snapshot;
    }
    collapseMapCache.set(workspaceId, { raw, snapshot: EMPTY_COLLAPSE_MAP });
    return EMPTY_COLLAPSE_MAP;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const snapshot = parsed as Record<string, boolean>;
      collapseMapCache.set(workspaceId, { raw, snapshot });
      return snapshot;
    }
  } catch {
    /* ignore */
  }

  collapseMapCache.set(workspaceId, { raw, snapshot: EMPTY_COLLAPSE_MAP });
  return EMPTY_COLLAPSE_MAP;
}

function writeCollapseMap(workspaceId: string, map: Record<string, boolean>): void {
  // Always update memory + notify so collapse works when sessionStorage is full or blocked.
  let raw: string | null = null;
  try {
    raw = JSON.stringify(map);
    sessionStorage.setItem(collapseStorageKey(workspaceId), raw);
  } catch {
    raw = null;
  }
  collapseMapCache.set(workspaceId, { raw, snapshot: map });
  notifyCollapseListeners();
}

function subscribeCollapseMap(onStoreChange: () => void): () => void {
  collapseListeners.add(onStoreChange);
  const onStorage = (event: StorageEvent) => {
    if (event.storageArea === sessionStorage && event.key?.startsWith('sm.stacks.collapse.')) {
      onStoreChange();
    }
  };
  window.addEventListener('storage', onStorage);
  return () => {
    collapseListeners.delete(onStoreChange);
    window.removeEventListener('storage', onStorage);
  };
}

function isRepoCollapsed(map: Record<string, boolean>, repositoryId: string): boolean {
  return map[repositoryId] === true;
}

/** True when a "/" press should focus search: not while typing somewhere else or using a modifier. */
function isSearchShortcut(event: KeyboardEvent): boolean {
  if (event.key !== '/' || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey)
    return false;
  const target = event.target;
  if (!(target instanceof HTMLElement)) return true;
  return !target.isContentEditable && !['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

export function OrganisedStacks(props: { workspaceId: string; stacks: GroupableStack[] }) {
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const collapsed = useSyncExternalStore(
    subscribeCollapseMap,
    () => readCollapseMap(props.workspaceId),
    () => EMPTY_COLLAPSE_MAP,
  );
  // While searching every group starts open so matches are never hidden. Toggles made during a search apply
  // to that search only and reset when the query changes; the saved browsing layout is left untouched.
  const term = query.trim();
  const searching = term !== '';
  const [searchCollapse, setSearchCollapse] = useState<{ term: string; map: Record<string, boolean> }>({
    term: '',
    map: EMPTY_COLLAPSE_MAP,
  });
  const searchCollapsed = searchCollapse.term === term ? searchCollapse.map : EMPTY_COLLAPSE_MAP;
  const activeCollapsed = searching ? searchCollapsed : collapsed;

  const filtered = useMemo(() => filterStacks(props.stacks, query), [props.stacks, query]);
  const groups = useMemo(() => groupStacks(filtered), [filtered]);

  const toggleRepo = useCallback(
    (repositoryId: string) => {
      if (searching) {
        setSearchCollapse({
          term,
          map: { ...searchCollapsed, [repositoryId]: !isRepoCollapsed(searchCollapsed, repositoryId) },
        });
        return;
      }
      const prev = readCollapseMap(props.workspaceId);
      const next = { ...prev, [repositoryId]: !isRepoCollapsed(prev, repositoryId) };
      writeCollapseMap(props.workspaceId, next);
    },
    [props.workspaceId, searching, term, searchCollapsed],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isSearchShortcut(event)) return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  const clearSearch = () => {
    setQuery('');
    searchRef.current?.focus();
  };

  return (
    <>
      <div className="stack-toolbar">
        <div className="search-field stack-search">
          <Search className="icon muted" aria-hidden="true" />
          <div className="stack-search-box">
            <input
              ref={searchRef}
              type="search"
              aria-label="Search stacks"
              aria-keyshortcuts="/"
              placeholder="Search stacks"
              autoComplete="off"
              spellCheck={false}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && query) {
                  e.preventDefault();
                  setQuery('');
                }
              }}
            />
            {query ? (
              <button
                type="button"
                className="stack-search-clear"
                aria-label="Clear search"
                onClick={clearSearch}
              >
                <X className="icon" aria-hidden="true" />
              </button>
            ) : (
              <kbd className="stack-search-kbd" aria-hidden="true">
                /
              </kbd>
            )}
          </div>
        </div>
        <p className="muted stack-count" role="status">
          {stackCountLabel(filtered.length, props.stacks.length)}
        </p>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={SearchX}
          title="No stacks match"
          actions={
            <Button size="sm" onClick={clearSearch}>
              Clear search
            </Button>
          }
        >
          Nothing matches “{term}” in stack names, repository names or paths.
        </EmptyState>
      ) : (
        <ul className="list" aria-label="Stacks by repository">
          {groups.flatMap((repo) => {
            const open = !isRepoCollapsed(activeCollapsed, repo.repositoryId);
            const rows: ReactNode[] = [
              <li key={`repo:${repo.repositoryId}`}>
                <button
                  type="button"
                  className="list-row"
                  aria-expanded={open}
                  onClick={() => toggleRepo(repo.repositoryId)}
                >
                  {open ? (
                    <ChevronDown className="icon muted" aria-hidden="true" />
                  ) : (
                    <ChevronRight className="icon muted" aria-hidden="true" />
                  )}
                  <div className="grow">
                    <div className="title truncate">{repo.repositoryName}</div>
                  </div>
                </button>
              </li>,
            ];
            if (!open) return rows;

            for (const folder of repo.folders) {
              if (repo.folders.length > 1) {
                rows.push(
                  <li key={`folder:${repo.repositoryId}:${folder.segment}`}>
                    <div className="list-row">
                      <span className="grow muted">{folder.segment}</span>
                    </div>
                  </li>,
                );
              }
              for (const stack of folder.stacks) {
                rows.push(
                  <li key={stack.id}>
                    <Link className="list-row" href={`/w/${props.workspaceId}/stacks/${stack.id}`}>
                      <Layers className="icon muted" aria-hidden="true" />
                      <div className="grow">
                        <div className="title truncate">{stack.name}</div>
                        <div className="muted truncate list-row-sub">
                          <span className="mono">{stack.rootPath || '(root)'}</span>
                        </div>
                      </div>
                      {stack.draftCount ? (
                        <span className="pill pending">
                          {stack.draftCount} draft{stack.draftCount === 1 ? '' : 's'}
                        </span>
                      ) : null}
                      <ChevronRight className="icon muted" aria-hidden="true" />
                    </Link>
                  </li>,
                );
              }
            }
            return rows;
          })}
        </ul>
      )}
    </>
  );
}
