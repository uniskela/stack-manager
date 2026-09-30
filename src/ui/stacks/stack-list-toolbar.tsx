'use client';

import { Check, ChevronsDownUp, ChevronsUpDown, Search, SlidersHorizontal, X } from 'lucide-react';
import { useEffect, useState, type ReactNode, type RefObject } from 'react';
import type { GroupableRepository } from '@/shared/stacks/group-stacks';
import {
  activeFilterCount,
  STACK_GROUPINGS,
  STACK_SORTS,
  type StackGrouping,
  type StackListState,
  type StackSort,
} from '@/shared/stacks/list-state';
import { Button } from '@/ui/primitives/button';

/** True when a "/" press should focus search: not while typing somewhere else or using a modifier. */
function isSearchShortcut(event: KeyboardEvent): boolean {
  if (event.key !== '/' || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey)
    return false;
  const target = event.target;
  if (!(target instanceof HTMLElement)) return true;
  return !target.isContentEditable && !['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

function FilterToggle(props: {
  pressed: boolean;
  onChange: (pressed: boolean) => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="filter-toggle"
      aria-pressed={props.pressed}
      onClick={() => props.onChange(!props.pressed)}
    >
      {props.pressed ? <Check className="icon" aria-hidden="true" /> : null}
      {props.children}
    </button>
  );
}

/**
 * Search, live result count, filters, sort, grouping and expand/collapse for the Stacks list. On phones the
 * filters, sort and grouping sit behind a "Filters" disclosure; on wider screens they are always shown.
 */
export function StackListToolbar(props: {
  state: StackListState;
  searchRef: RefObject<HTMLInputElement | null>;
  onChange: (patch: Partial<StackListState>) => void;
  countLabel: string;
  repositories: GroupableRepository[];
  showDraftsFilter: boolean;
  showAttentionFilter: boolean;
  /** Expand/collapse every group; omitted when the list is not grouped. */
  onExpandAll?: () => void;
  onCollapseAll?: () => void;
}) {
  const { state, onChange, searchRef } = props;
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filterCount = activeFilterCount(state);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isSearchShortcut(event)) return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [searchRef]);

  const clearSearch = () => {
    onChange({ q: '' });
    searchRef.current?.focus();
  };

  return (
    <div className="stack-toolbar">
      <div className="stack-toolbar-row">
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
              value={state.q}
              onChange={(e) => onChange({ q: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && state.q) {
                  e.preventDefault();
                  onChange({ q: '' });
                }
              }}
            />
            {state.q ? (
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
          {props.countLabel}
        </p>
      </div>

      <div className="stack-toolbar-row">
        <Button
          size="sm"
          className="stack-filters-toggle"
          aria-expanded={filtersOpen}
          aria-controls="stack-filters"
          icon={<SlidersHorizontal className="icon" aria-hidden="true" />}
          onClick={() => setFiltersOpen((open) => !open)}
        >
          Filters
          {filterCount ? (
            <span className="count">
              {filterCount}
              <span className="visually-hidden"> active</span>
            </span>
          ) : null}
        </Button>

        <div id="stack-filters" className="stack-filters" data-open={filtersOpen}>
          {props.showDraftsFilter || state.drafts ? (
            <FilterToggle pressed={state.drafts} onChange={(drafts) => onChange({ drafts })}>
              Has drafts
            </FilterToggle>
          ) : null}
          {props.showAttentionFilter || state.attention ? (
            <FilterToggle pressed={state.attention} onChange={(attention) => onChange({ attention })}>
              Needs attention
            </FilterToggle>
          ) : null}
          {props.repositories.length > 1 || state.repo ? (
            <select
              className="compact-select"
              aria-label="Repository"
              value={state.repo ?? ''}
              onChange={(e) => onChange({ repo: e.target.value || null })}
            >
              <option value="">All repositories</option>
              {props.repositories.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          ) : null}
          {filterCount ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onChange({ drafts: false, attention: false, repo: null })}
            >
              Clear filters
            </Button>
          ) : null}

          <div className="stack-view">
            <label className="inline-select">
              <span>Sort</span>
              <select
                className="compact-select"
                value={state.sort}
                onChange={(e) => onChange({ sort: e.target.value as StackSort })}
              >
                {STACK_SORTS.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="inline-select">
              <span>Group</span>
              <select
                className="compact-select"
                value={state.group}
                onChange={(e) => onChange({ group: e.target.value as StackGrouping })}
              >
                {STACK_GROUPINGS.map((g) => (
                  <option key={g.value} value={g.value}>
                    {g.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        {props.onExpandAll && props.onCollapseAll ? (
          <div className="stack-expand">
            <Button
              size="sm"
              variant="ghost"
              iconOnly
              aria-label="Expand all"
              title="Expand all"
              icon={<ChevronsUpDown className="icon" aria-hidden="true" />}
              onClick={props.onExpandAll}
            />
            <Button
              size="sm"
              variant="ghost"
              iconOnly
              aria-label="Collapse all"
              title="Collapse all"
              icon={<ChevronsDownUp className="icon" aria-hidden="true" />}
              onClick={props.onCollapseAll}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
