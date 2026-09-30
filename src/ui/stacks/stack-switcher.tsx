'use client';

import { Check, ChevronsUpDown, Search } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { filterStacks, folderLabel, groupStacks } from '@/shared/stacks/group-stacks';
import { Button } from '@/ui/primitives/button';
import { moveFocus } from './arrow-focus';

type SwitcherStack = { id: string; name: string; rootPath: string };

/** A filter field appears once the list is long enough to need one. */
const FILTER_THRESHOLD = 8;

/**
 * Jump to another stack in the same repository without going back to the list. Keeps the current tab (Docs,
 * Changes, …) but not the open file, which belongs to the stack being left.
 */
export function StackSwitcher(props: {
  workspaceId: string;
  currentId: string;
  repository: { id: string; name: string };
  stacks: SwitcherStack[];
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const panelId = useId();
  const pathname = usePathname();

  const base = `/w/${props.workspaceId}/stacks/${props.currentId}`;
  const tab = pathname.startsWith(base) ? pathname.slice(base.length) : '';
  const showFilter = props.stacks.length > FILTER_THRESHOLD;
  const groups = useMemo(() => {
    const withRepo = props.stacks.map((s) => ({ ...s, repository: props.repository }));
    return groupStacks(filterStacks(withRepo, query))[0]?.folders ?? [];
  }, [props.stacks, props.repository, query]);

  const close = (returnFocus: boolean) => {
    setOpen(false);
    setQuery('');
    if (returnFocus) buttonRef.current?.focus();
  };

  // Focus moves into the panel on open; a click outside closes it.
  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'nearest' });
    if (showFilter) filterRef.current?.focus();
    else if (panelRef.current) moveFocus(panelRef.current, 'a', 'Home');
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setOpen(false);
      setQuery('');
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, showFilter]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
      return;
    }
    const panel = panelRef.current;
    if (!panel) return;
    if (event.target === filterRef.current) {
      if (event.key === 'ArrowDown' && moveFocus(panel, 'a', 'Home')) event.preventDefault();
      return;
    }
    if (moveFocus(panel, 'a', event.key)) event.preventDefault();
    else if (event.key === 'ArrowUp' && showFilter) {
      event.preventDefault();
      filterRef.current?.focus();
    }
  };

  if (props.stacks.length < 2) return null;

  return (
    <div className="stack-switcher" ref={rootRef} onKeyDown={open ? onKeyDown : undefined}>
      <Button
        ref={buttonRef}
        size="sm"
        aria-expanded={open}
        aria-controls={panelId}
        icon={<ChevronsUpDown className="icon" aria-hidden="true" />}
        onClick={() => (open ? close(false) : setOpen(true))}
      >
        Switch stack
      </Button>
      <div className="stack-switcher-panel" id={panelId} ref={panelRef} hidden={!open}>
        <p className="stack-switcher-title">Stacks in {props.repository.name}</p>
        {showFilter ? (
          <div className="search-field stack-switcher-filter">
            <Search className="icon muted" aria-hidden="true" />
            <input
              ref={filterRef}
              type="search"
              aria-label="Filter stacks"
              placeholder="Filter stacks"
              autoComplete="off"
              spellCheck={false}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        ) : null}
        {groups.length === 0 ? (
          <p className="muted stack-switcher-empty">No stacks match.</p>
        ) : (
          groups.map((folder) => (
            <div key={folder.path} className="stack-switcher-group">
              <p className="stack-switcher-folder">{folderLabel(folder.path)}</p>
              <ul aria-label={folderLabel(folder.path)}>
                {folder.stacks.map((s) => {
                  const current = s.id === props.currentId;
                  return (
                    <li key={s.id}>
                      <Link
                        href={`/w/${props.workspaceId}/stacks/${s.id}${tab}`}
                        aria-current={current ? 'page' : undefined}
                        onClick={() => close(false)}
                      >
                        <span className="truncate">{s.name}</span>
                        {current ? <Check className="icon" aria-hidden="true" /> : null}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
