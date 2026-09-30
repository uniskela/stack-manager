'use client';

import { ChevronDown, ChevronRight, Layers, Search } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { filterStacks, groupStacks, type GroupableStack } from '@/shared/stacks/group-stacks';

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

export function OrganisedStacks(props: { workspaceId: string; stacks: GroupableStack[] }) {
  const [query, setQuery] = useState('');
  const collapsed = useSyncExternalStore(
    subscribeCollapseMap,
    () => readCollapseMap(props.workspaceId),
    () => EMPTY_COLLAPSE_MAP,
  );

  const filtered = useMemo(() => filterStacks(props.stacks, query), [props.stacks, query]);
  const groups = useMemo(() => groupStacks(filtered), [filtered]);

  const toggleRepo = useCallback(
    (repositoryId: string) => {
      const prev = readCollapseMap(props.workspaceId);
      const next = { ...prev, [repositoryId]: !isRepoCollapsed(prev, repositoryId) };
      writeCollapseMap(props.workspaceId, next);
    },
    [props.workspaceId],
  );

  return (
    <>
      <div className="search-field">
        <Search className="icon muted" aria-hidden="true" />
        <input
          type="search"
          aria-label="Search stacks"
          placeholder="Search stacks"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {filtered.length === 0 ? (
        <p className="muted">No stacks match.</p>
      ) : (
        <ul className="list" aria-label="Stacks by repository">
          {groups.flatMap((repo) => {
            const open = !isRepoCollapsed(collapsed, repo.repositoryId);
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
