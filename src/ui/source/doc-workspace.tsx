'use client';

import { FileText, Save, Undo2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { relativeTo } from '@/shared/source/paths';
import type { FileView } from '@/shared/source/types';
import { api, ApiError } from '../api';
import { Alert } from '../primitives/alert';
import { Button } from '../primitives/button';
import { EmptyState } from '../primitives/empty-state';
import { CodeEditor } from './code-editor';
import { MarkdownView } from './markdown-view';

type Mode = 'read' | 'edit' | 'split';

const errorText = (err: unknown) => (err instanceof ApiError ? err.message : 'Could not reach the server.');

/**
 * Notion-style documentation for a stack: a page list on the left and a clean reading view, with
 * Edit and Split (live preview) modes. Markdown stays the source format so files round-trip through Git
 * unchanged.
 */
export function DocWorkspace(props: {
  workspaceId: string;
  stackId: string;
  rootPath: string;
  docs: { path: string; draft: boolean }[];
  file: FileView | null;
  hrefFor: Record<string, string>;
  editorHref: string;
  docsHref: string;
}) {
  const router = useRouter();
  const base = `/api/workspaces/${props.workspaceId}/stacks/${props.stackId}`;
  const [file, setFile] = useState(props.file);
  const initial = file?.draft?.content ?? file?.content ?? '';
  const [text, setText] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [version, setVersion] = useState(0);
  const [mode, setMode] = useState<Mode>('read');
  const [busy, setBusy] = useState<'save' | 'discard' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const dirty = text !== saved;

  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  if (props.docs.length === 0) {
    return (
      <EmptyState icon={FileText} title="No documentation yet">
        Markdown files in the stack folder (such as README.md or docs/*.md) appear here. Create one from the
        Editor with the New file button.
      </EmptyState>
    );
  }

  const save = async () => {
    if (!file || !dirty || busy) return;
    setBusy('save');
    setError(null);
    try {
      const res = await api<{ file: FileView }>(`${base}/drafts`, {
        method: 'PUT',
        body: { path: file.path, content: text, baseBlobSha: file.draft?.baseBlobSha ?? file.blobSha },
      });
      setFile(res.file);
      setSaved(text);
      setAnnouncement('Draft saved.');
      router.refresh();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const discard = async () => {
    if (!file?.draft) {
      setText(saved);
      setVersion((v) => v + 1);
      return;
    }
    if (!window.confirm('Discard this draft? The committed version is kept.')) return;
    setBusy('discard');
    setError(null);
    try {
      const res = await api<{ file: FileView | null }>(
        `${base}/drafts?path=${encodeURIComponent(file.path)}`,
        {
          method: 'DELETE',
        },
      );
      const next = res.file?.content ?? '';
      setFile(res.file);
      setText(next);
      setSaved(next);
      setVersion((v) => v + 1);
      setAnnouncement('Draft discarded.');
      router.refresh();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const links = file
    ? { docPath: file.path, rootPath: props.rootPath, editorHref: props.editorHref, docsHref: props.docsHref }
    : undefined;

  const editor = file ? (
    <div className="doc-editor">
      <CodeEditor
        className="editor-surface"
        docKey={`${file.path}#${version}`}
        initialValue={text}
        language="markdown"
        wrap
        onChange={setText}
        onSave={save}
      />
    </div>
  ) : null;

  return (
    <div className="docs">
      <nav className="docs-nav" aria-label="Documentation pages">
        <ul>
          {props.docs.map((d) => (
            <li key={d.path}>
              <Link href={props.hrefFor[d.path]!} aria-current={d.path === file?.path ? 'page' : undefined}>
                <FileText className="icon" aria-hidden="true" />
                <span className="truncate">{relativeTo(props.rootPath, d.path)}</span>
                {d.draft ? <span className="tree-badge modified">M</span> : null}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <article className="doc-page" aria-label={file?.path}>
        {!file ? (
          <Alert tone="error">This page could not be loaded.</Alert>
        ) : (
          <>
            <div className="doc-bar">
              <div className="segmented-control" role="group" aria-label="View mode">
                {(['read', 'edit', 'split'] as const).map((m) => (
                  <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}>
                    {m === 'read' ? 'Read' : m === 'edit' ? 'Edit' : 'Split'}
                  </button>
                ))}
              </div>
              <div className="actions">
                {file.draft ? <span className="pill pending">Draft</span> : null}
                {dirty ? <span className="fine-print">Unsaved changes</span> : null}
                {file.draft || dirty ? (
                  <Button
                    size="sm"
                    onClick={discard}
                    loading={busy === 'discard'}
                    disabled={busy !== null}
                    icon={<Undo2 className="icon" aria-hidden="true" />}
                  >
                    {file.draft ? 'Discard draft' : 'Revert'}
                  </Button>
                ) : null}
                <Button
                  variant="primary"
                  size="sm"
                  onClick={save}
                  loading={busy === 'save'}
                  disabled={!dirty || busy !== null}
                  icon={<Save className="icon" aria-hidden="true" />}
                >
                  Save draft
                </Button>
              </div>
            </div>
            {error ? (
              <Alert tone="error" role="alert">
                {error}
              </Alert>
            ) : null}
            {file.draft?.outdated ? (
              <Alert tone="warn" title="This page changed upstream">
                The committed version was updated after this draft was started.
              </Alert>
            ) : null}
            {mode === 'read' ? (
              <MarkdownView source={text} links={links} />
            ) : mode === 'edit' ? (
              editor
            ) : (
              <div className="doc-split">
                {editor}
                <MarkdownView source={text} links={links} />
              </div>
            )}
          </>
        )}
        <span className="visually-hidden" role="status" aria-live="polite">
          {announcement}
        </span>
      </article>
    </div>
  );
}
