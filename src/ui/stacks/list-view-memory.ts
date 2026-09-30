'use client';

import { useSyncExternalStore } from 'react';
import { parseStackListState, serialiseStackListState } from '@/shared/stacks/list-state';

/**
 * The Stacks list's last view per workspace (its query string), so links back to the list from a stack page return
 * to the same search, filters and grouping. Stored in sessionStorage; reads are re-parsed and re-serialised, so the
 * result is always a well-formed list URL whatever the storage holds.
 */
function storageKey(workspaceId: string): string {
  return `sm.stacks.view.${workspaceId}`;
}

export function rememberListView(workspaceId: string, query: string): void {
  try {
    if (query) sessionStorage.setItem(storageKey(workspaceId), query);
    else sessionStorage.removeItem(storageKey(workspaceId));
  } catch {
    // Storage blocked or full: links fall back to the plain list.
  }
}

function readListHref(workspaceId: string): string {
  const base = `/w/${workspaceId}/stacks`;
  let saved: string | null = null;
  try {
    saved = sessionStorage.getItem(storageKey(workspaceId));
  } catch {
    return base;
  }
  const query = saved ? serialiseStackListState(parseStackListState(new URLSearchParams(saved))) : '';
  return query ? `${base}?${query}` : base;
}

const subscribe = () => () => {};

/** Href of the Stacks list with the view the operator last left it in (the plain list during server render). */
export function useStacksListHref(workspaceId: string): string {
  return useSyncExternalStore(
    subscribe,
    () => readListHref(workspaceId),
    () => `/w/${workspaceId}/stacks`,
  );
}
