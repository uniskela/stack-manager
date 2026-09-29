'use client';

import {
  CircleAlert,
  FilePlus,
  FolderTree,
  Info,
  Lock,
  Save,
  TriangleAlert,
  Undo2,
  WrapText,
  X,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react';
import type { Severity } from '@/shared/source/compose';
import {
  isSecretPath,
  isWithin,
  joinRepoPath,
  languageFor,
  normalizeRepoPath,
  relativeTo,
  RepoPathError,
} from '@/shared/source/paths';
import { isCompose, problemsFor } from '@/shared/source/problems';
import { LOCK_LABELS, type FileView, type TreeNodeView } from '@/shared/source/types';
import { api, ApiError } from '../api';
import { Alert } from '../primitives/alert';
import { Button } from '../primitives/button';
import { CodeEditor } from './code-editor';
import { FileTree } from './file-tree';

interface Tab {
  path: string;
  file: FileView | null;
  error: string | null;
  /** Bumped when the buffer is replaced from the server (discard), resetting editor state. */
  version: number;
  /** Current buffer. */
  text: string;
  /** Text as last persisted (draft or committed content). */
  saved: string;
}

export interface StackEditorProps {
  workspaceId: string;
  /** Source API of the scope: `/api/workspaces/:w/stacks/:s` or `/api/workspaces/:w/repositories/:r/source`. */
  apiBase: string;
  /** Folder the editor is scoped to ('' for the whole repository). */
  rootPath: string;
  /** The stack's Compose file; any compose-named file is validated as Compose either way. */
  composePath?: string;
  branch: string;
  commitSha: string;
  entries: TreeNodeView[];
  initialFile: FileView | null;
}

const LANGUAGE_LABELS: Record<string, string> = {
  yaml: 'YAML',
  markdown: 'Markdown',
  json: 'JSON',
  dotenv: 'Env',
  shell: 'Shell',
  dockerfile: 'Dockerfile',
  toml: 'TOML',
  text: 'Plain text',
};

const SEVERITY_ICON: Record<Severity, typeof CircleAlert> = {
  error: CircleAlert,
  warning: TriangleAlert,
  info: Info,
};

const errorText = (err: unknown) => (err instanceof ApiError ? err.message : 'Could not reach the server.');

function tabFromFile(file: FileView): Tab {
  const text = file.draft?.content ?? file.content ?? '';
  return { path: file.path, file, error: null, version: 0, text, saved: text };
}

/**
 * VS Code-style editor for one stack (or a whole repository): explorer, tabs, CodeMirror, live problems and a status bar.
 * Saving stores a draft on the server (PR #3); committing and pushing drafts arrives in PR #4.
 */
export function StackEditor(props: StackEditorProps) {
  const router = useRouter();
  const base = props.apiBase;
  const [tabs, setTabs] = useState<Tab[]>(() => (props.initialFile ? [tabFromFile(props.initialFile)] : []));
  const [activePath, setActivePath] = useState<string | null>(props.initialFile?.path ?? null);
  const [filter, setFilter] = useState('');
  const [explorerOpen, setExplorerOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newError, setNewError] = useState<string | null>(null);
  const [wrap, setWrap] = useState(false);
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [jump, setJump] = useState<{ line: number; nonce: number } | null>(null);
  const [busy, setBusy] = useState<'save' | 'discard' | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [problemsOpen, setProblemsOpen] = useState<boolean | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const active = tabs.find((t) => t.path === activePath) ?? null;
  const dirtyPaths = useMemo(
    () =>
      new Set(
        tabs
          .filter((t) => t.text !== t.saved || (t.file && !t.file.blobSha && !t.file.draft))
          .map((t) => t.path),
      ),
    [tabs],
  );
  const activeDirty = active ? dirtyPaths.has(active.path) : false;
  const deferredText = useDeferredValue(active?.text ?? '');
  const problems = useMemo(
    () => (active?.file?.editable ? problemsFor(active.path, deferredText, props.composePath) : []),
    [active?.path, active?.file?.editable, deferredText, props.composePath],
  );
  const counts = useMemo(
    () => ({
      error: problems.filter((p) => p.severity === 'error').length,
      warning: problems.filter((p) => p.severity === 'warning').length,
      info: problems.filter((p) => p.severity === 'info').length,
    }),
    [problems],
  );

  // Phones: soft-wrap on and the problems list collapsed, so the editor keeps most of the screen (docs/UX.md).
  useEffect(() => {
    const narrow = window.matchMedia('(max-width: 900px)').matches;
    setWrap(narrow);
    setProblemsOpen(!narrow);
  }, []);

  // Keep ?file= in the URL so reloads and shared links reopen the same file.
  useEffect(() => {
    if (!activePath) return;
    const url = new URL(window.location.href);
    url.searchParams.set('file', relativeTo(props.rootPath, activePath));
    window.history.replaceState(window.history.state, '', url);
  }, [activePath, props.rootPath]);

  // Warn before leaving with unsaved buffers.
  useEffect(() => {
    if (dirtyPaths.size === 0) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirtyPaths]);

  const updateTab = (path: string, patch: (t: Tab) => Tab) =>
    setTabs((prev) => prev.map((t) => (t.path === path ? patch(t) : t)));

  const openFile = useCallback(
    async (path: string) => {
      setExplorerOpen(false);
      setActivePath(path);
      setActionError(null);
      if (tabs.some((t) => t.path === path)) return;
      setTabs((prev) => [...prev, { path, file: null, error: null, version: 0, text: '', saved: '' }]);
      try {
        const { file } = await api<{ file: FileView }>(`${base}/files?path=${encodeURIComponent(path)}`);
        setTabs((prev) => prev.map((t) => (t.path === path ? tabFromFile(file) : t)));
      } catch (err) {
        setTabs((prev) => prev.map((t) => (t.path === path ? { ...t, error: errorText(err) } : t)));
      }
    },
    [base, tabs],
  );

  const closeTab = (path: string) => {
    if (dirtyPaths.has(path) && !window.confirm(`Close ${path} and lose unsaved changes?`)) return;
    const index = tabs.findIndex((t) => t.path === path);
    const remaining = tabs.filter((t) => t.path !== path);
    setTabs(remaining);
    if (activePath === path) setActivePath(remaining[Math.max(0, index - 1)]?.path ?? null);
  };

  const save = useCallback(async () => {
    if (!active?.file?.editable || busy) return;
    if (!dirtyPaths.has(active.path)) return;
    setBusy('save');
    setActionError(null);
    const content = active.text;
    try {
      const { file } = await api<{ file: FileView }>(`${base}/drafts`, {
        method: 'PUT',
        body: {
          path: active.path,
          content,
          baseBlobSha: active.file.draft?.baseBlobSha ?? active.file.blobSha,
        },
      });
      updateTab(active.path, (t) => ({ ...t, file, saved: content }));
      setAnnouncement(
        file.draft ? `Draft saved: ${active.path}` : `No changes from the commit: ${active.path}`,
      );
      router.refresh();
    } catch (err) {
      setActionError(errorText(err));
    } finally {
      setBusy(null);
    }
  }, [active, base, busy, dirtyPaths, router]);

  const discard = async () => {
    if (!active?.file) return;
    // A new file that was never saved only exists in this tab.
    if (!active.file.draft && !active.file.blobSha) {
      closeTab(active.path);
      return;
    }
    if (!active.file.draft) {
      updateTab(active.path, (t) => ({ ...t, text: t.saved, version: t.version + 1 }));
      return;
    }
    if (!window.confirm(`Discard the draft of ${active.path}? The committed version is kept.`)) return;
    setBusy('discard');
    setActionError(null);
    try {
      const { file } = await api<{ file: FileView | null }>(
        `${base}/drafts?path=${encodeURIComponent(active.path)}`,
        { method: 'DELETE' },
      );
      if (!file) {
        setTabs((prev) => prev.filter((t) => t.path !== active.path));
        setActivePath(null);
      } else {
        const text = file.content ?? '';
        updateTab(active.path, (t) => ({ ...t, file, text, saved: text, version: t.version + 1 }));
      }
      setAnnouncement(`Draft discarded: ${active.path}`);
      router.refresh();
    } catch (err) {
      setActionError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const createFile = (e: React.FormEvent) => {
    e.preventDefault();
    let path: string;
    try {
      path = normalizeRepoPath(joinRepoPath(props.rootPath, normalizeRepoPath(newName)));
    } catch (err) {
      setNewError(err instanceof RepoPathError ? err.message : 'Invalid file name.');
      return;
    }
    if (!isWithin(props.rootPath, path))
      return setNewError(
        props.rootPath ? 'Choose a path inside the stack folder.' : 'Choose a path inside the repository.',
      );
    if (isSecretPath(path)) return setNewError('Secret files (.env, keys, secrets/) cannot be created here.');
    if (props.entries.some((x) => x.path === path) || tabs.some((t) => t.path === path)) {
      setNewError(null);
      setCreating(false);
      setNewName('');
      void openFile(path);
      return;
    }
    const file: FileView = {
      path,
      language: languageFor(path),
      commitSha: props.commitSha,
      blobSha: null,
      size: 0,
      content: null,
      editable: true,
      locked: null,
      draft: null,
    };
    setTabs((prev) => [...prev, { path, file, error: null, version: 0, text: '', saved: '' }]);
    setActivePath(path);
    setCreating(false);
    setNewName('');
    setNewError(null);
    setExplorerOpen(false);
  };

  const docKey = (t: Tab) => `${t.path}#${t.version}`;
  const openKeys = useMemo(() => tabs.map(docKey), [tabs]);
  const displayPath = (p: string) => relativeTo(props.rootPath, p) || p;
  const shortSha = props.commitSha.slice(0, 7);

  return (
    <div className="ide" data-explorer={explorerOpen ? 'open' : 'closed'}>
      <aside className="ide-explorer" aria-label="Explorer">
        <div className="pane-head">
          <span>Explorer</span>
          <div className="actions">
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label="New file"
              title="New file"
              onClick={() => setCreating((v) => !v)}
              icon={<FilePlus className="icon" aria-hidden="true" />}
            />
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              className="only-narrow"
              aria-label="Close explorer"
              onClick={() => setExplorerOpen(false)}
              icon={<X className="icon" aria-hidden="true" />}
            />
          </div>
        </div>
        {creating ? (
          <form className="explorer-filter" onSubmit={createFile}>
            <label className="visually-hidden" htmlFor="new-file-name">
              New file path, relative to the stack folder
            </label>
            <input
              id="new-file-name"
              type="text"
              placeholder="e.g. config/app.yaml"
              value={newName}
              autoFocus
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              aria-invalid={newError ? true : undefined}
              aria-describedby={newError ? 'new-file-error' : undefined}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && setCreating(false)}
            />
            {newError ? (
              <div id="new-file-error" className="error-text">
                {newError}
              </div>
            ) : null}
          </form>
        ) : null}
        <div className="explorer-filter">
          <input
            type="text"
            placeholder="Filter files"
            aria-label="Filter files"
            value={filter}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        <div className="explorer-body">
          <FileTree
            entries={props.entries}
            root={props.rootPath}
            activePath={activePath}
            dirtyPaths={dirtyPaths}
            filter={filter}
            onOpen={openFile}
          />
        </div>
      </aside>

      <section className="ide-main" aria-label="Editor">
        <div className="editor-tabs">
          {tabs.map((t) => (
            <div
              key={t.path}
              className="editor-tab"
              aria-current={t.path === activePath ? 'true' : undefined}
            >
              <button type="button" className="open" onClick={() => setActivePath(t.path)} title={t.path}>
                <span>{t.path.slice(t.path.lastIndexOf('/') + 1)}</span>
                {dirtyPaths.has(t.path) ? (
                  <>
                    <span className="dirty-dot" aria-hidden="true" />
                    <span className="visually-hidden">(unsaved)</span>
                  </>
                ) : null}
              </button>
              <button
                type="button"
                className="close"
                aria-label={`Close ${t.path}`}
                onClick={() => closeTab(t.path)}
              >
                <X className="icon" aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>

        <div className="editor-toolbar">
          <div className="editor-path">
            <Button
              variant="ghost"
              size="sm"
              className="only-narrow"
              onClick={() => setExplorerOpen(true)}
              icon={<FolderTree className="icon" aria-hidden="true" />}
            >
              Files
            </Button>
            {active ? <span className="mono">{displayPath(active.path)}</span> : null}
            {active?.file?.draft ? <span className="pill pending">Draft</span> : null}
            {active?.file && !active.file.blobSha ? <span className="pill ok">New file</span> : null}
          </div>
          {active?.file?.editable ? (
            <div className="actions">
              {active.file.draft || activeDirty ? (
                <Button
                  size="sm"
                  onClick={discard}
                  loading={busy === 'discard'}
                  disabled={busy !== null}
                  icon={<Undo2 className="icon" aria-hidden="true" />}
                >
                  {active.file.draft ? 'Discard draft' : 'Revert'}
                </Button>
              ) : null}
              <Button
                variant="primary"
                size="sm"
                onClick={save}
                loading={busy === 'save'}
                disabled={!activeDirty || busy !== null}
                title="Save draft (Ctrl/⌘ + S)"
                icon={<Save className="icon" aria-hidden="true" />}
              >
                Save draft
              </Button>
            </div>
          ) : null}
        </div>

        {actionError ? (
          <div className="editor-notice">
            <Alert tone="error" role="alert">
              {actionError}
            </Alert>
          </div>
        ) : null}
        {active?.file?.draft?.outdated ? (
          <div className="editor-notice">
            <Alert tone="warn" title="This file changed upstream">
              The committed version was updated after this draft was started. Review the draft before
              committing.
            </Alert>
          </div>
        ) : null}

        {!active ? (
          <div className="editor-empty">
            <div>
              <p>Select a file in the explorer to start editing.</p>
              <p className="fine-print">
                Edits are saved as drafts. Commit and push arrive in the next update.
              </p>
            </div>
          </div>
        ) : active.error ? (
          <div className="editor-empty">
            <Alert tone="error">{active.error}</Alert>
          </div>
        ) : !active.file ? (
          <div className="editor-empty" aria-busy="true">
            <p>Loading…</p>
          </div>
        ) : active.file.locked ? (
          <div className="editor-empty">
            <div>
              <Lock className="empty-icon" aria-hidden="true" />
              <p>{LOCK_LABELS[active.file.locked]}</p>
            </div>
          </div>
        ) : (
          <CodeEditor
            docKey={docKey(active)}
            initialValue={active.text}
            language={active.file.language}
            compose={isCompose(active.path, props.composePath)}
            wrap={wrap}
            problems={problems}
            openKeys={openKeys}
            jump={jump}
            onChange={(text) => updateTab(active.path, (t) => ({ ...t, text }))}
            onCursor={(line, column) => setCursor({ line, column })}
            onSave={save}
          />
        )}

        {active?.file?.editable ? (
          <details
            className="problems"
            open={problemsOpen ?? false}
            onToggle={(e) => setProblemsOpen(e.currentTarget.open)}
          >
            <summary>
              Problems
              <span className="sev-error">{counts.error}</span>
              <span className="sev-warning">{counts.warning}</span>
              <span className="sev-info">{counts.info}</span>
            </summary>
            {problems.length === 0 ? (
              <p className="fine-print problem">No problems detected.</p>
            ) : (
              <ul>
                {problems.map((p, i) => {
                  const Icon = SEVERITY_ICON[p.severity];
                  return (
                    <li key={`${p.from}-${i}`}>
                      <button
                        type="button"
                        className="problem"
                        onClick={() => setJump({ line: p.line, nonce: Date.now() })}
                      >
                        <Icon className={`icon sev-${p.severity}`} aria-label={p.severity} />
                        <span>{p.message}</span>
                        <span className="where">
                          Ln {p.line}, Col {p.column}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </details>
        ) : null}

        <div className="status-bar">
          <span title={props.commitSha}>
            {props.branch} @ {shortSha}
          </span>
          {active?.file ? <span>{LANGUAGE_LABELS[active.file.language] ?? active.file.language}</span> : null}
          {active?.file?.editable ? (
            <span>
              Ln {cursor.line}, Col {cursor.column}
            </span>
          ) : null}
          <span className="spacer" />
          {active?.file?.editable ? (
            <span>{activeDirty ? 'Unsaved changes' : active.file.draft ? 'Draft saved' : 'No changes'}</span>
          ) : null}
          <button
            type="button"
            aria-pressed={wrap}
            onClick={() => setWrap((w) => !w)}
            title="Toggle word wrap"
          >
            <WrapText className="icon" aria-hidden="true" /> Wrap
          </button>
        </div>
        <span className="visually-hidden" role="status" aria-live="polite">
          {announcement}
        </span>
      </section>
    </div>
  );
}
