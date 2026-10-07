'use client';

import { GitCommitHorizontal, History } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import type { HistoryCommit, HistoryDetail, HistoryPage } from '@/shared/git-history';
import { relativeTo } from '@/shared/source/paths';
import { api, ApiError } from '../api';
import { LocalTime } from '../local-time';
import { Alert } from '../primitives/alert';
import { Button } from '../primitives/button';
import { EmptyState } from '../primitives/empty-state';
import { UnifiedDiff } from './unified-diff';

const FILE_STATUS: Record<HistoryCommit['files'][number]['status'], string> = {
  added: 'Added',
  modified: 'Modified',
  deleted: 'Deleted',
  type_changed: 'Type changed',
};

const LOCKED_REASON: Record<NonNullable<HistoryDetail['commit']['files'][number]['locked']>, string> = {
  secret: 'Secret file — contents are not shown.',
  symlink: 'Symlink — contents are not shown.',
  submodule: 'Submodule — contents are not shown.',
  binary: 'Binary file — contents are not shown.',
  too_large: 'File is too large to show a diff.',
  diff_limit: 'Diff exceeded size limits.',
  unsupported_path: 'This path cannot be shown in the editor.',
};

const PREVIEW_FILES = 8;

function fileLabel(rootPath: string, path: string) {
  return relativeTo(rootPath, path) || path;
}

async function fetchPage(apiBase: string, cursor: string | null): Promise<HistoryPage> {
  const q = new URLSearchParams({ limit: '20' });
  if (cursor) q.set('cursor', cursor);
  return api<HistoryPage>(`${apiBase}/history?${q}`);
}

function FileList({
  rootPath,
  files,
  truncated,
}: {
  rootPath: string;
  files: HistoryCommit['files'];
  truncated: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? files : files.slice(0, PREVIEW_FILES);
  const hidden = files.length - visible.length;
  return (
    <ul className="history-files">
      {visible.map((f) => (
        <li key={f.path}>
          <span className="mono">{fileLabel(rootPath, f.path)}</span>{' '}
          <span className="pill">{FILE_STATUS[f.status]}</span>
        </li>
      ))}
      {hidden > 0 || truncated ? (
        <li>
          {hidden > 0 ? (
            <Button variant="ghost" size="sm" onClick={() => setExpanded(true)}>
              Show {hidden} more file{hidden === 1 ? '' : 's'}
            </Button>
          ) : null}
          {truncated ? <span className="fine-print">File list truncated by the server.</span> : null}
        </li>
      ) : null}
    </ul>
  );
}

function CommitDetail({
  apiBase,
  rootPath,
  sha,
  onClose,
}: {
  apiBase: string;
  rootPath: string;
  sha: string;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<HistoryDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void api<HistoryDetail>(`${apiBase}/history/${sha}`)
      .then((d) => {
        if (cancelled) return;
        setDetail(d);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : 'Could not load this commit.');
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [apiBase, sha]);

  return (
    <section className="card flush history-detail" aria-label="Commit details">
      <div className="change-head">
        <div>
          <h3 className="history-detail-title">Commit detail</h3>
          <p className="fine-print mono">{sha}</p>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close commit details">
          Close
        </Button>
      </div>
      {loading ? <p className="fine-print change-head">Loading changes…</p> : null}
      {error ? (
        <Alert tone="error" role="alert">
          {error}
        </Alert>
      ) : null}
      {detail
        ? detail.commit.files.map((f) => {
            const rel = fileLabel(rootPath, f.path);
            return (
              <div key={f.path} className="history-file-diff">
                <div className="change-head">
                  <div>
                    <span className="mono">{rel}</span> <span className="pill">{FILE_STATUS[f.status]}</span>
                  </div>
                </div>
                {f.locked ? (
                  <p className="fine-print change-head">{LOCKED_REASON[f.locked]}</p>
                ) : f.hunks === null ? (
                  <p className="fine-print change-head">Diff unavailable.</p>
                ) : (
                  <UnifiedDiff hunks={f.hunks} label={`Changes in ${rel}`} />
                )}
              </div>
            );
          })
        : null}
      {detail && detail.commit.files.length === 0 ? (
        <p className="fine-print change-head">No files changed in this stack scope.</p>
      ) : null}
      {detail?.commit.filesTruncated ? (
        <p className="fine-print change-head">File list truncated by the server.</p>
      ) : null}
    </section>
  );
}

/** Stack-scoped Git history at the last fetched snapshot, with optional commit detail. */
export function HistoryView({ apiBase, rootPath }: { apiBase: string; rootPath: string }) {
  const listId = useId();
  const [commits, setCommits] = useState<HistoryCommit[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [limitReached, setLimitReached] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void fetchPage(apiBase, null)
      .then((page) => {
        if (cancelled) return;
        setCommits(page.commits);
        setNextCursor(page.nextCursor);
        setLimitReached(page.historyLimitReached);
        setError(null);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : 'Could not load history.');
        setCommits([]);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [apiBase, reloadToken]);

  const loadMore = async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await fetchPage(apiBase, nextCursor);
      setCommits((prev) => [...prev, ...page.commits]);
      setNextCursor(page.nextCursor);
      setLimitReached(page.historyLimitReached);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load history.');
    } finally {
      setLoadingMore(false);
    }
  };

  if (loading) {
    return (
      <p className="muted" role="status">
        Loading history…
      </p>
    );
  }

  if (error && commits.length === 0) {
    return (
      <div className="stack">
        <Alert tone="error" role="alert">
          {error}
        </Alert>
        <Button
          onClick={() => {
            setLoading(true);
            setReloadToken((n) => n + 1);
          }}
        >
          Try again
        </Button>
      </div>
    );
  }

  if (commits.length === 0) {
    return (
      <EmptyState icon={History} title="No commits for this stack">
        No commits touching this stack were found at the last fetch. Commits you push appear here after the
        repository is fetched again.
      </EmptyState>
    );
  }

  return (
    <div className="stack history-view">
      <p className="fine-print">
        Commits that touched this stack, as of the last fetch. Commits you push appear after the next fetch.
      </p>
      {error ? (
        <Alert tone="error" role="alert">
          {error}
        </Alert>
      ) : null}
      <ul className="history-list" id={listId} aria-label="Stack history">
        {commits.map((c) => {
          const open = selected === c.sha;
          return (
            <li key={c.sha} className="history-item">
              <button
                type="button"
                className="history-row"
                aria-expanded={open}
                aria-controls={open ? `commit-${c.sha}` : undefined}
                onClick={() => setSelected(open ? null : c.sha)}
              >
                <GitCommitHorizontal className="icon muted" aria-hidden="true" />
                <span className="history-row-main">
                  <span className="history-subject">{c.subject}</span>
                  <span className="fine-print history-meta">
                    <span className="mono">{c.shortSha}</span>
                    <span aria-hidden="true"> · </span>
                    <span>{c.author.name}</span>
                    <span aria-hidden="true"> · </span>
                    <LocalTime iso={c.authoredAt} />
                  </span>
                </span>
              </button>
              {c.files.length > 0 ? (
                <FileList rootPath={rootPath} files={c.files} truncated={c.filesTruncated} />
              ) : (
                <p className="fine-print history-files-empty">No files in this stack scope</p>
              )}
              {open ? (
                <div id={`commit-${c.sha}`}>
                  <CommitDetail
                    key={c.sha}
                    apiBase={apiBase}
                    rootPath={rootPath}
                    sha={c.sha}
                    onClose={() => setSelected(null)}
                  />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {nextCursor ? (
        <Button loading={loadingMore} onClick={() => void loadMore()}>
          Load more
        </Button>
      ) : null}
      {limitReached ? (
        <p className="fine-print">
          Older commits are not listed here. Use your Git server to browse further back.
        </p>
      ) : null}
    </div>
  );
}
