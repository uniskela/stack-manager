'use client';

import { ChevronDown, ChevronRight, FolderGit2, Layers, PencilLine, Search, SearchX, X } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  filterStacks,
  folderLabel,
  groupStacks,
  pluralise,
  stackCountLabel,
  stackRowDetail,
  type GroupableStack,
  type StackFolderGroup,
  type StackRepoGroup,
} from '@/shared/stacks/group-stacks';
import { Button } from '@/ui/primitives/button';
import { EmptyState } from '@/ui/primitives/empty-state';
import { StatusPill } from '@/ui/primitives/status-pill';
import {
  EMPTY_COLLAPSE_MAP,
  folderCollapseKey,
  isCollapsed,
  readCollapseMap,
  subscribeCollapseMap,
  writeCollapseMap,
} from './collapse-store';

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

  const toggle = useCallback(
    (key: string) => {
      if (searching) {
        setSearchCollapse({ term, map: { ...searchCollapsed, [key]: !isCollapsed(searchCollapsed, key) } });
        return;
      }
      const prev = readCollapseMap(props.workspaceId);
      writeCollapseMap(props.workspaceId, { ...prev, [key]: !isCollapsed(prev, key) });
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
        <div className="stack-groups">
          {groups.map((repo) => (
            <RepositoryGroup
              key={repo.repositoryId}
              workspaceId={props.workspaceId}
              repo={repo}
              collapsed={activeCollapsed}
              onToggle={toggle}
            />
          ))}
        </div>
      )}
    </>
  );
}

function Chevron({ open }: { open: boolean }) {
  const Icon = open ? ChevronDown : ChevronRight;
  return <Icon className="icon muted" aria-hidden="true" />;
}

/** A repository section: heading with counts and fetch state, then its folder groups. */
function RepositoryGroup(props: {
  workspaceId: string;
  repo: StackRepoGroup;
  collapsed: Record<string, boolean>;
  onToggle: (key: string) => void;
}) {
  const { repo } = props;
  const open = !isCollapsed(props.collapsed, repo.repositoryId);
  const headingId = `stack-repo-${repo.repositoryId}`;
  const bodyId = `${headingId}-body`;
  const drafts = repo.repository.draftCount ?? 0;
  const status = repo.repository.syncStatus ?? 'ready';
  return (
    <section className="stack-repo" aria-labelledby={headingId}>
      <div className="stack-repo-head">
        <h2 className="stack-repo-title" id={headingId}>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={() => props.onToggle(repo.repositoryId)}
          >
            <Chevron open={open} />
            <span className="truncate">{repo.repositoryName}</span>
          </button>
        </h2>
        <span className="stack-repo-meta">
          {pluralise(repo.stackCount, 'stack')}
          {drafts ? ` · ${pluralise(drafts, 'draft')}` : null}
        </span>
        {status !== 'ready' ? <StatusPill status={status} /> : null}
        <Link
          className="btn ghost small icon-only"
          href={`/w/${props.workspaceId}/repositories/${repo.repositoryId}`}
          aria-label={`Open repository ${repo.repositoryName}`}
          title="Open repository"
        >
          <FolderGit2 className="icon" aria-hidden="true" />
        </Link>
      </div>
      <div className="stack-repo-body" id={bodyId} hidden={!open}>
        {repo.folders.map((folder, index) => (
          <FolderGroup
            key={folder.path}
            id={`${headingId}-folder-${index}`}
            workspaceId={props.workspaceId}
            repositoryId={repo.repositoryId}
            folder={folder}
            collapsed={props.collapsed}
            onToggle={props.onToggle}
          />
        ))}
      </div>
    </section>
  );
}

/** Stacks sharing a parent folder, under a collapsible path label. */
function FolderGroup(props: {
  id: string;
  workspaceId: string;
  repositoryId: string;
  folder: StackFolderGroup;
  collapsed: Record<string, boolean>;
  onToggle: (key: string) => void;
}) {
  const key = folderCollapseKey(props.repositoryId, props.folder.path);
  const open = !isCollapsed(props.collapsed, key);
  const label = folderLabel(props.folder.path);
  return (
    <div className="stack-folder">
      <h3 className="stack-folder-title">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={props.id}
          onClick={() => props.onToggle(key)}
        >
          <Chevron open={open} />
          <span className={props.folder.path ? 'mono truncate' : 'truncate'}>{label}</span>
          <span className="stack-folder-count">
            {props.folder.stacks.length}
            <span className="visually-hidden"> {props.folder.stacks.length === 1 ? 'stack' : 'stacks'}</span>
          </span>
        </button>
      </h3>
      <ul className="stack-rows" id={props.id} hidden={!open} aria-label={`Stacks in ${label}`}>
        {props.folder.stacks.map((stack) => (
          <StackRow key={stack.id} workspaceId={props.workspaceId} stack={stack} />
        ))}
      </ul>
    </div>
  );
}

function StackRow({ workspaceId, stack }: { workspaceId: string; stack: GroupableStack }) {
  const detail = stackRowDetail(stack);
  const drafts = stack.draftCount ?? 0;
  return (
    <li>
      <Link className="stack-row" href={`/w/${workspaceId}/stacks/${stack.id}`}>
        <Layers className="icon muted" aria-hidden="true" />
        <span className="stack-row-name truncate">{stack.name}</span>
        {detail ? <span className="stack-row-detail truncate">{detail}</span> : null}
        {drafts ? (
          <span className="draft-badge">
            <PencilLine className="icon" aria-hidden="true" />
            {pluralise(drafts, 'draft')}
            {stack.rootPath === '' ? ' in repository' : null}
          </span>
        ) : null}
      </Link>
    </li>
  );
}
