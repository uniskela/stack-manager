/**
 * Collapse state for the Stacks list, per workspace, in sessionStorage. Keys are repository ids and
 * `folderCollapseKey` values; `true` means collapsed. An in-memory snapshot keeps toggles working when storage is
 * full or blocked.
 */
function collapseStorageKey(workspaceId: string): string {
  return `sm.stacks.collapse.${workspaceId}`;
}

const collapseListeners = new Set<() => void>();

/** Stable empty snapshot for useSyncExternalStore when storage is missing or invalid. */
export const EMPTY_COLLAPSE_MAP: Record<string, boolean> = Object.freeze({});

type CollapseCacheEntry = {
  /** Last serialised value known to match sessionStorage, or null when empty / unpersisted. */
  raw: string | null;
  snapshot: Record<string, boolean>;
  /**
   * Snapshot is newer than sessionStorage (setItem failed). Reads must return this snapshot until a
   * write succeeds — otherwise getItem still yields the previous stored map and overwrites the toggle.
   */
  dirty: boolean;
};

const collapseMapCache = new Map<string, CollapseCacheEntry>();

function notifyCollapseListeners(): void {
  for (const listener of collapseListeners) {
    listener();
  }
}

export function readCollapseMap(workspaceId: string): Record<string, boolean> {
  const cached = collapseMapCache.get(workspaceId);
  if (cached?.dirty) {
    return cached.snapshot;
  }

  let raw: string | null;
  try {
    raw = sessionStorage.getItem(collapseStorageKey(workspaceId));
  } catch {
    // Storage unavailable — keep toggles working via the in-memory snapshot.
    return cached?.snapshot ?? EMPTY_COLLAPSE_MAP;
  }

  if (cached !== undefined && cached.raw === raw) {
    return cached.snapshot;
  }

  if (!raw) {
    collapseMapCache.set(workspaceId, { raw, snapshot: EMPTY_COLLAPSE_MAP, dirty: false });
    return EMPTY_COLLAPSE_MAP;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const snapshot = parsed as Record<string, boolean>;
      collapseMapCache.set(workspaceId, { raw, snapshot, dirty: false });
      return snapshot;
    }
  } catch {
    /* ignore */
  }

  collapseMapCache.set(workspaceId, { raw, snapshot: EMPTY_COLLAPSE_MAP, dirty: false });
  return EMPTY_COLLAPSE_MAP;
}

export function writeCollapseMap(workspaceId: string, map: Record<string, boolean>): void {
  // Always update memory + notify so collapse works when sessionStorage is full or blocked.
  let raw: string | null = null;
  let dirty = false;
  try {
    raw = JSON.stringify(map);
    sessionStorage.setItem(collapseStorageKey(workspaceId), raw);
  } catch {
    // setItem throws before replacing the previous value; keep the new snapshot as dirty.
    raw = null;
    dirty = true;
  }
  collapseMapCache.set(workspaceId, { raw, snapshot: map, dirty });
  notifyCollapseListeners();
}

export function subscribeCollapseMap(onStoreChange: () => void): () => void {
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

export function isCollapsed(map: Record<string, boolean>, key: string): boolean {
  return map[key] === true;
}

export function folderCollapseKey(repositoryId: string, path: string): string {
  return `${repositoryId}:${path}`;
}
