'use client';

import { ChevronDown, ChevronRight, FolderGit2, Layers, PencilLine, SearchX } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  folderLabel,
  groupStacks,
  naturalCompare,
  pluralise,
  stackCountLabel,
  stackRowDetail,
  type GroupableStack,
  type StackFolderGroup,
  type StackRepoGroup,
} from '@/shared/stacks/group-stacks';
import {
  activeFilterCount,
  applyStackFilters,
  highlightParts,
  isNarrowed,
  narrowingKey,
  needsAttention,
  parseStackListState,
  serialiseStackListState,
  stackComparator,
  type StackGrouping,
  type StackListState,
} from '@/shared/stacks/list-state';
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
import { StackListToolbar } from './stack-list-toolbar';

/** Typing settles before the URL is rewritten (browsers throttle rapid history updates). */
const URL_WRITE_DELAY_MS = 250;

export function OrganisedStacks(props: { workspaceId: string; stacks: GroupableStack[] }) {
  const searchParams = useSearchParams();
  const [state, setState] = useState<StackListState>(() => parseStackListState(searchParams));
  const onChange = useCallback((patch: Partial<StackListState>) => setState((s) => ({ ...s, ...patch })), []);
  const searchRef = useRef<HTMLInputElement>(null);

  const repositories = useMemo(() => {
    const byId = new Map(props.stacks.map((s) => [s.repository.id, s.repository]));
    return [...byId.values()].sort((a, b) => naturalCompare(a.name, b.name) || a.id.localeCompare(b.id));
  }, [props.stacks]);
  // A repository filter from an old link that no longer matches anything is ignored.
  const view = useMemo(
    () => (state.repo && !repositories.some((r) => r.id === state.repo) ? { ...state, repo: null } : state),
    [state, repositories],
  );

  // Keep the view in the URL so Back, reload and shared links reproduce it. Pending writes flush before a stack
  // link navigates, so the list entry in history always holds the latest view.
  const query = serialiseStackListState(view);
  const pendingUrl = useRef<string | null>(null);
  const flushUrl = useCallback(() => {
    if (pendingUrl.current === null) return;
    window.history.replaceState(window.history.state, '', pendingUrl.current);
    pendingUrl.current = null;
  }, []);
  useEffect(() => {
    const url = `${window.location.pathname}${query ? `?${query}` : ''}`;
    if (url === `${window.location.pathname}${window.location.search}`) {
      pendingUrl.current = null;
      return;
    }
    pendingUrl.current = url;
    const timer = window.setTimeout(flushUrl, URL_WRITE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [query, flushUrl]);

  // Collapse state: the saved per-browser layout, except while search or a filter narrows the list. Then every
  // group starts open so matches are never hidden, and toggles apply only until the narrowing changes.
  const saved = useSyncExternalStore(
    subscribeCollapseMap,
    () => readCollapseMap(props.workspaceId),
    () => EMPTY_COLLAPSE_MAP,
  );
  const narrowed = isNarrowed(view);
  const key = narrowingKey(view);
  const [scoped, setScoped] = useState({ key: '', map: EMPTY_COLLAPSE_MAP });
  const scopedMap = scoped.key === key ? scoped.map : EMPTY_COLLAPSE_MAP;
  const collapsed = narrowed ? scopedMap : saved;
  const setCollapsed = useCallback(
    (patch: Record<string, boolean>) => {
      if (narrowed) setScoped({ key, map: { ...scopedMap, ...patch } });
      else writeCollapseMap(props.workspaceId, { ...readCollapseMap(props.workspaceId), ...patch });
    },
    [narrowed, key, scopedMap, props.workspaceId],
  );
  const toggle = useCallback(
    (k: string) => setCollapsed({ [k]: !isCollapsed(collapsed, k) }),
    [collapsed, setCollapsed],
  );

  const filtered = useMemo(() => applyStackFilters(props.stacks, view), [props.stacks, view]);
  const compare = useMemo(() => stackComparator(view.sort), [view.sort]);
  const groups = useMemo(
    () => (view.group === 'none' ? [] : groupStacks(filtered, compare)),
    [filtered, compare, view.group],
  );

  // Collapse all folds repositories only, leaving an overview of repository headers with their counts.
  const collapseAll = () => setCollapsed(Object.fromEntries(groups.map((repo) => [repo.repositoryId, true])));
  const expandAll = () => {
    const patch: Record<string, boolean> = {};
    for (const repo of groups) {
      patch[repo.repositoryId] = false;
      for (const f of repo.folders) patch[folderCollapseKey(repo.repositoryId, f.path)] = false;
    }
    setCollapsed(patch);
  };

  const grouping = view.group;

  const clearNarrowing = () => {
    onChange({ q: '', drafts: false, attention: false, repo: null });
    searchRef.current?.focus();
  };

  return (
    <>
      <StackListToolbar
        state={view}
        searchRef={searchRef}
        onChange={onChange}
        countLabel={stackCountLabel(filtered.length, props.stacks.length)}
        repositories={repositories}
        showDraftsFilter={props.stacks.some((s) => (s.draftCount ?? 0) > 0)}
        showAttentionFilter={repositories.some(needsAttention)}
        onExpandAll={view.group === 'none' ? undefined : expandAll}
        onCollapseAll={view.group === 'none' ? undefined : collapseAll}
      />

      {filtered.length === 0 ? (
        <EmptyState
          icon={SearchX}
          title="No stacks match"
          actions={
            <Button size="sm" onClick={clearNarrowing}>
              Clear search and filters
            </Button>
          }
        >
          {view.q.trim()
            ? `Nothing matches “${view.q.trim()}” in stack names, repository names or paths${
                activeFilterCount(view) ? ' with the current filters' : ''
              }.`
            : 'No stacks match the current filters.'}
        </EmptyState>
      ) : (
        // Clicks reach the capture phase before a stack link navigates.
        <div className="stack-groups" onClickCapture={flushUrl}>
          {grouping === 'none' ? (
            <div className="stack-repo">
              <ul className="stack-rows stack-rows-flat" aria-label="Stacks">
                {[...filtered].sort(compare).map((stack) => (
                  <StackRow
                    key={stack.id}
                    workspaceId={props.workspaceId}
                    stack={stack}
                    grouping="none"
                    query={view.q}
                  />
                ))}
              </ul>
            </div>
          ) : (
            groups.map((repo) => (
              <RepositoryGroup
                key={repo.repositoryId}
                workspaceId={props.workspaceId}
                repo={repo}
                grouping={grouping}
                compare={compare}
                query={view.q}
                collapsed={collapsed}
                onToggle={toggle}
              />
            ))
          )}
        </div>
      )}
    </>
  );
}

function Chevron({ open }: { open: boolean }) {
  const Icon = open ? ChevronDown : ChevronRight;
  return <Icon className="icon muted" aria-hidden="true" />;
}

/** Text with search terms wrapped in `<mark>`. */
function Highlight({ text, query }: { text: string; query: string }) {
  return (
    <>
      {highlightParts(text, query).map((part, i) =>
        part.match ? <mark key={i}>{part.text}</mark> : part.text,
      )}
    </>
  );
}

/** A repository section: heading with counts and fetch state, then its folder groups or a flat list. */
function RepositoryGroup(props: {
  workspaceId: string;
  repo: StackRepoGroup;
  grouping: Exclude<StackGrouping, 'none'>;
  compare: (a: GroupableStack, b: GroupableStack) => number;
  query: string;
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
            <span className="truncate">
              <Highlight text={repo.repositoryName} query={props.query} />
            </span>
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
        {props.grouping === 'folder' ? (
          repo.folders.map((folder, index) => (
            <FolderGroup
              key={folder.path}
              id={`${headingId}-folder-${index}`}
              workspaceId={props.workspaceId}
              repositoryId={repo.repositoryId}
              folder={folder}
              query={props.query}
              collapsed={props.collapsed}
              onToggle={props.onToggle}
            />
          ))
        ) : (
          <ul className="stack-rows stack-rows-flat" aria-label={`Stacks in ${repo.repositoryName}`}>
            {repo.folders
              .flatMap((f) => f.stacks)
              .sort(props.compare)
              .map((stack) => (
                <StackRow
                  key={stack.id}
                  workspaceId={props.workspaceId}
                  stack={stack}
                  grouping="repository"
                  query={props.query}
                />
              ))}
          </ul>
        )}
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
  query: string;
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
          <span className={props.folder.path ? 'mono truncate' : 'truncate'}>
            {props.folder.path ? <Highlight text={label} query={props.query} /> : label}
          </span>
          <span className="stack-folder-count">
            {props.folder.stacks.length}
            <span className="visually-hidden"> {props.folder.stacks.length === 1 ? 'stack' : 'stacks'}</span>
          </span>
        </button>
      </h3>
      <ul className="stack-rows" id={props.id} hidden={!open} aria-label={`Stacks in ${label}`}>
        {props.folder.stacks.map((stack) => (
          <StackRow
            key={stack.id}
            workspaceId={props.workspaceId}
            stack={stack}
            grouping="folder"
            query={props.query}
          />
        ))}
      </ul>
    </div>
  );
}

/** What a row adds after the name: less when a group header already says where the stack lives. */
function rowDetail(stack: GroupableStack, grouping: StackGrouping): string | null {
  switch (grouping) {
    case 'folder':
      return stackRowDetail(stack);
    case 'repository':
      return stack.rootPath || 'Whole repository';
    case 'none':
      return `${stack.repository.name} · ${stack.rootPath || 'whole repository'}`;
  }
}

function StackRow(props: {
  workspaceId: string;
  stack: GroupableStack;
  grouping: StackGrouping;
  query: string;
}) {
  const { stack } = props;
  const detail = rowDetail(stack, props.grouping);
  const drafts = stack.draftCount ?? 0;
  return (
    <li>
      <Link className="stack-row" href={`/w/${props.workspaceId}/stacks/${stack.id}`}>
        <Layers className="icon muted" aria-hidden="true" />
        <span className="stack-row-name truncate">
          <Highlight text={stack.name} query={props.query} />
        </span>
        {detail ? (
          <span className="stack-row-detail truncate">
            <Highlight text={detail} query={props.query} />
          </span>
        ) : null}
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
