'use client';

import { structuredPatch } from 'diff';
import { GitCompareArrows } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { GitWorkflowProblem, GitWorkflowResult } from '@/shared/git-workflow';
import { relativeTo } from '@/shared/source/paths';
import { problemsFor } from '@/shared/source/problems';
import type { ChangeView } from '@/shared/source/types';
import { api, ApiError, gitWorkflow } from '../api';
import { LocalTime } from '../local-time';
import { Alert } from '../primitives/alert';
import { Button, ButtonLink } from '../primitives/button';
import { ConfirmButton } from '../primitives/confirm-button';
import { EmptyState } from '../primitives/empty-state';

type GitIdentity = { name: string; email: string };

function shortSha(sha: string) {
  return sha.slice(0, 7);
}

function Diff({ before, after }: { before: string; after: string }) {
  const patch = structuredPatch('before', 'after', before, after, '', '', { context: 3 });
  if (patch.hunks.length === 0) return <p className="fine-print change-head">No textual changes.</p>;
  return (
    <div className="diff" role="table" aria-label="Line changes">
      {patch.hunks.map((hunk, h) => {
        let oldLine = hunk.oldStart;
        let newLine = hunk.newStart;
        return (
          <div key={h} role="rowgroup">
            <div className="diff-hunk" role="row">
              <span role="cell">
                @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
              </span>
            </div>
            {hunk.lines.map((line, i) => {
              const sign = line[0];
              if (sign === '\\') return null;
              const kind = sign === '+' ? 'add' : sign === '-' ? 'remove' : 'same';
              const oldNo = kind === 'add' ? '' : oldLine++;
              const newNo = kind === 'remove' ? '' : newLine++;
              return (
                <div key={i} className={`diff-line ${kind}`} role="row">
                  <span className="ln" role="cell">
                    {oldNo}
                  </span>
                  <span className="ln" role="cell">
                    {newNo}
                  </span>
                  <span
                    className="sign"
                    role="cell"
                    aria-label={kind === 'same' ? undefined : kind === 'add' ? 'added' : 'removed'}
                  >
                    {kind === 'same' ? ' ' : sign}
                  </span>
                  <span role="cell">{line.slice(1)}</span>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

function problemLabel(problem: GitWorkflowProblem) {
  if (problem.code === 'hardcoded-secret') return 'Hard-coded secret';
  if (problem.severity === 'error') return 'Error';
  if (problem.severity === 'warning') return 'Warning';
  return 'Info';
}

function WorkflowAlert(props: {
  result: GitWorkflowResult;
  editorHref: string;
  rootPath: string;
  repositoryHref: string;
  identityHref: string;
  onAcknowledge?: () => void;
}) {
  const { result } = props;
  const fileLink = (path: string) => {
    const rel = relativeTo(props.rootPath, path) || path;
    return `${props.editorHref}?file=${encodeURIComponent(rel)}`;
  };

  if (result.status === 'push_succeeded' && result.commitSha) {
    return (
      <Alert tone="ok" role="status" title={`Pushed ${shortSha(result.commitSha)} to ${result.branch}.`}>
        Drafts are still on this server — review or discard them after you confirm the remote looks right.
      </Alert>
    );
  }
  if (result.status === 'commit_succeeded' && result.commitSha) {
    return (
      <Alert tone="ok" role="status" title={`Committed as ${shortSha(result.commitSha)}.`}>
        Drafts remain until you discard them. You can push this commit when ready.
      </Alert>
    );
  }
  if (result.status === 'validation_blocked') {
    return (
      <Alert tone="error" role="alert" title="Fix validation errors before committing">
        <ul className="problem-list">
          {result.problems
            .filter((p) => p.severity === 'error')
            .map((p, i) => (
              <li key={`${p.path}:${p.line}:${i}`}>
                <Link href={fileLink(p.path)}>{relativeTo(props.rootPath, p.path) || p.path}</Link>
                {p.line > 0 ? `:${p.line}` : ''} — {problemLabel(p)}
              </li>
            ))}
        </ul>
      </Alert>
    );
  }
  if (result.status === 'warnings_unacknowledged') {
    return (
      <Alert tone="warn" role="alert" title="Review warnings before committing">
        <ul className="problem-list">
          {result.problems
            .filter((p) => p.severity === 'warning')
            .map((p, i) => (
              <li key={`${p.path}:${p.line}:${i}`}>
                <Link href={fileLink(p.path)}>{relativeTo(props.rootPath, p.path) || p.path}</Link>
                {p.line > 0 ? `:${p.line}` : ''} — {problemLabel(p)}
              </li>
            ))}
        </ul>
        {props.onAcknowledge ? (
          <p className="fine-print">Tick “Commit despite warnings” below, then try again.</p>
        ) : null}
      </Alert>
    );
  }
  if (result.status === 'git_identity_missing') {
    return (
      <Alert tone="warn" role="alert" title="Git identity required to commit">
        Set your name and email under Account settings before committing. Reads and drafts still work.
        <div className="actions">
          <ButtonLink href={props.identityHref} variant="primary">
            Open Git identity settings
          </ButtonLink>
        </div>
      </Alert>
    );
  }
  if (result.status === 'draft_outdated') {
    return (
      <Alert tone="error" role="alert" title="Some drafts are out of date">
        These files changed upstream since the draft was started. Open them, review, and save again before
        committing:{' '}
        {result.outdatedPaths.map((path, i) => (
          <span key={path}>
            {i > 0 ? ', ' : ''}
            <Link href={fileLink(path)}>{relativeTo(props.rootPath, path) || path}</Link>
          </span>
        ))}
        .
      </Alert>
    );
  }
  if (result.status === 'remote_changed') {
    return (
      <Alert tone="warn" role="alert" title="The remote branch changed since your copy was last updated.">
        Nothing was overwritten and your drafts are still safe. Fetch the latest changes before trying again.
        {result.commitSha ? <span> Local commit {shortSha(result.commitSha)} is retained.</span> : null}
        <div className="actions">
          <ButtonLink href={props.repositoryHref}>Open repository to fetch</ButtonLink>
        </div>
        {result.reason ? (
          <p className="fine-print">Technical detail: {result.reason} (non-fast-forward).</p>
        ) : null}
      </Alert>
    );
  }
  if (result.status === 'push_rejected') {
    return (
      <Alert tone="error" role="alert" title="The remote refused this push.">
        Nothing was overwritten and your drafts are still safe
        {result.commitSha ? (
          <span>
            {' '}
            — local commit {shortSha(result.commitSha)} is retained for retry after you review permissions or
            policy.
          </span>
        ) : (
          '.'
        )}
        {result.reason ? <p className="fine-print">Technical detail: {result.reason}.</p> : null}
      </Alert>
    );
  }
  if (result.status === 'branch_changed') {
    return (
      <Alert tone="warn" role="alert" title="The local branch moved since this operation started.">
        Nothing was overwritten and your drafts are still safe. Refresh and review before trying again.
        {result.commitSha ? <span> Local commit {shortSha(result.commitSha)} is retained.</span> : null}
      </Alert>
    );
  }
  if (result.status === 'repository_busy') {
    return (
      <Alert tone="warn" role="alert" title="Another Git operation is in progress">
        Wait a moment and try again. Your drafts are still safe.
      </Alert>
    );
  }
  if (result.status === 'git_operation_failed') {
    return (
      <Alert tone="error" role="alert" title="The Git operation could not be completed">
        Your drafts are still safe
        {result.commitSha ? <span> and local commit {shortSha(result.commitSha)} is retained.</span> : '.'}
        {result.reason ? <p className="fine-print">Reason: {result.reason}.</p> : null}
      </Alert>
    );
  }
  return null;
}

/** Review of draft changes in a stack or repository, with commit and optional push. */
export function ChangesView(props: {
  workspaceId: string;
  repositoryId: string;
  /** Source API of the scope (see StackEditorProps.apiBase). */
  apiBase: string;
  rootPath: string;
  changes: ChangeView[];
  editorHref: string;
  branch: string;
  gitIdentity: GitIdentity | null;
  /** Registered Compose path for stack-scoped validation; omit on repository Changes. */
  composePath?: string;
}) {
  const router = useRouter();
  const messageId = useId();
  const alertRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState(() => new Set(props.changes.map((c) => c.path)));
  const [message, setMessage] = useState('');
  const [acknowledgeWarnings, setAcknowledgeWarnings] = useState(false);
  const [busy, setBusy] = useState<'discard' | 'commit' | 'commit-push' | 'push' | null>(null);
  const [discardPath, setDiscardPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<GitWorkflowResult | null>(null);
  const [retained, setRetained] = useState<{
    commitSha: string;
    expectedRemoteSha: string;
    branch: string;
  } | null>(null);

  const gitBase = `/api/workspaces/${props.workspaceId}/repositories/${props.repositoryId}/git`;
  const repositoryHref = `/w/${props.workspaceId}/repositories/${props.repositoryId}`;
  const identityHref = `/w/${props.workspaceId}/settings/account#ws-account-git-identity`;

  useEffect(() => {
    if (result || error) alertRef.current?.focus();
  }, [result, error]);

  // Empty `selected` means the user cleared the selection. Non-empty but all-stale means refresh.
  const selectedChanges = useMemo(() => {
    const picked = props.changes.filter((c) => selected.has(c.path));
    if (picked.length > 0 || selected.size === 0) return picked;
    return props.changes;
  }, [props.changes, selected]);
  const selectedPaths = useMemo(() => new Set(selectedChanges.map((c) => c.path)), [selectedChanges]);
  const clientProblems = useMemo(
    () =>
      selectedChanges.flatMap((c) =>
        problemsFor(c.path, c.after, props.composePath).map((p) => ({
          path: c.path,
          line: p.line,
          column: p.column,
          severity: p.severity,
          code: (p.code ??
            (p.severity === 'error'
              ? 'source_error'
              : p.severity === 'warning'
                ? 'source_warning'
                : 'source_info')) as GitWorkflowProblem['code'],
        })),
      ),
    [selectedChanges, props.composePath],
  );
  const blockingErrors = clientProblems.filter((p) => p.severity === 'error');
  const warnings = clientProblems.filter((p) => p.severity === 'warning');
  const outdatedSelected = selectedChanges.filter((c) => c.outdated);
  const canCommit =
    !!props.gitIdentity &&
    selectedChanges.length > 0 &&
    message.trim().length > 0 &&
    blockingErrors.length === 0 &&
    outdatedSelected.length === 0 &&
    busy === null;

  const toggle = (path: string) => {
    setSelected((prev) => {
      const hasCurrent = props.changes.some((c) => prev.has(c.path));
      const next = !hasCurrent && prev.size > 0 ? new Set(props.changes.map((c) => c.path)) : new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const applyResult = (next: GitWorkflowResult) => {
    setResult(next);
    if (next.commitSha && next.expectedRemoteSha && next.status !== 'push_succeeded') {
      setRetained({
        commitSha: next.commitSha,
        expectedRemoteSha: next.expectedRemoteSha,
        branch: next.branch,
      });
    }
    if (next.status === 'push_succeeded') setRetained(null);
    if (next.status === 'warnings_unacknowledged') setAcknowledgeWarnings(false);
  };

  const discard = async (path: string) => {
    setBusy('discard');
    setDiscardPath(path);
    setError(null);
    try {
      await api(`${props.apiBase}/drafts?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server.');
    } finally {
      setBusy(null);
      setDiscardPath(null);
    }
  };

  const commit = async (push: boolean) => {
    setBusy(push ? 'commit-push' : 'commit');
    setError(null);
    setResult(null);
    try {
      const next = await gitWorkflow(`${gitBase}/commit`, {
        method: 'POST',
        body: {
          paths: selectedChanges.map((c) => c.path),
          message: message.trim(),
          push,
          acknowledgeWarnings: acknowledgeWarnings || undefined,
        },
      });
      applyResult(next);
      if (next.status === 'commit_succeeded' || next.status === 'push_succeeded') {
        setMessage('');
        setAcknowledgeWarnings(false);
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server.');
    } finally {
      setBusy(null);
    }
  };

  const pushRetained = async () => {
    if (!retained) return;
    setBusy('push');
    setError(null);
    setResult(null);
    try {
      const next = await gitWorkflow(`${gitBase}/push`, {
        method: 'POST',
        body: {
          commitSha: retained.commitSha,
          expectedRemoteSha: retained.expectedRemoteSha,
        },
      });
      applyResult(next);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server.');
    } finally {
      setBusy(null);
    }
  };

  if (props.changes.length === 0 && !retained) {
    return (
      <EmptyState icon={GitCompareArrows} title="No draft changes">
        Edits you save in the Editor or Docs appear here for review before they are committed.
      </EmptyState>
    );
  }

  const showWarningAck =
    acknowledgeWarnings || warnings.length > 0 || result?.status === 'warnings_unacknowledged';
  const needsWarningAck =
    (warnings.length > 0 || result?.status === 'warnings_unacknowledged') && !acknowledgeWarnings;

  return (
    <div className="stack changes-view">
      <div className="changes-summary" role="status">
        {props.changes.length === 0 ? (
          <strong>No drafts left</strong>
        ) : (
          <>
            <strong>
              {props.changes.length} draft{props.changes.length === 1 ? '' : 's'}
            </strong>
            {' · '}
            {selectedChanges.length} selected for commit
          </>
        )}
        {outdatedSelected.length ? (
          <>
            {' · '}
            <span className="pill failed">{outdatedSelected.length} outdated</span>
          </>
        ) : null}
        {blockingErrors.length ? (
          <>
            {' · '}
            <span className="pill failed">
              {blockingErrors.length} blocking error{blockingErrors.length === 1 ? '' : 's'}
            </span>
          </>
        ) : null}
        {warnings.length && !blockingErrors.length ? (
          <>
            {' · '}
            <span className="pill pending">
              {warnings.length} warning{warnings.length === 1 ? '' : 's'}
            </span>
          </>
        ) : null}
      </div>

      {!props.gitIdentity ? (
        <Alert tone="warn" title="Git identity required to commit">
          Set your name and email under Account settings before committing. Reads and drafts still work.
          <div className="actions">
            <ButtonLink href={identityHref} variant="primary">
              Open Git identity settings
            </ButtonLink>
          </div>
        </Alert>
      ) : null}

      <div ref={alertRef} tabIndex={-1} className="stack focus-target">
        {error ? (
          <Alert tone="error" role="alert">
            {error}
          </Alert>
        ) : null}
        {result ? (
          <WorkflowAlert
            result={result}
            editorHref={props.editorHref}
            rootPath={props.rootPath}
            repositoryHref={repositoryHref}
            identityHref={identityHref}
          />
        ) : null}
        {result?.commitSha &&
        result.status !== 'commit_succeeded' &&
        result.status !== 'push_succeeded' &&
        result.status !== 'validation_blocked' &&
        result.status !== 'warnings_unacknowledged' &&
        result.status !== 'draft_outdated' &&
        result.status !== 'git_identity_missing' ? (
          <Alert tone="ok" role="status">
            Committed as {shortSha(result.commitSha)}. Your drafts are still on this server.
          </Alert>
        ) : null}
      </div>

      <section className="card commit-panel" aria-label="Commit changes">
        <div className="change-head">
          <div>
            <strong>{props.changes.length === 0 && retained ? 'Push retained commit' : 'Commit'}</strong>
            <div className="fine-print">
              {props.changes.length === 0 && retained ? (
                <>
                  Local commit <span className="mono">{shortSha(retained.commitSha)}</span> · branch{' '}
                  <span className="mono">{retained.branch}</span>
                </>
              ) : (
                <>
                  {selectedChanges.length} file{selectedChanges.length === 1 ? '' : 's'} · branch{' '}
                  <span className="mono">{props.branch}</span>
                  {props.gitIdentity ? (
                    <>
                      {' '}
                      · author{' '}
                      <span className="mono">
                        {props.gitIdentity.name} &lt;{props.gitIdentity.email}&gt;
                      </span>
                    </>
                  ) : null}
                </>
              )}
            </div>
          </div>
        </div>
        {props.changes.length === 0 && retained ? (
          <div className="form commit-form">
            <p className="fine-print">
              Drafts for this change set were discarded. The retained commit is still available to push.
            </p>
            <div className="actions commit-actions">
              <Button
                variant="primary"
                type="button"
                loading={busy === 'push'}
                disabled={busy !== null}
                onClick={() => void pushRetained()}
              >
                Push {shortSha(retained.commitSha)}
              </Button>
            </div>
          </div>
        ) : (
          <form
            className="form commit-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (canCommit) void commit(false);
            }}
          >
            <div className="field">
              <label htmlFor={messageId}>Commit message</label>
              <textarea
                id={messageId}
                name="commitMessage"
                rows={3}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                required
                disabled={!props.gitIdentity || busy !== null}
                spellCheck
                maxLength={8192}
              />
            </div>
            {blockingErrors.length ? (
              <Alert tone="error" title="Validation blocked">
                <ul className="problem-list">
                  {blockingErrors.map((p, i) => {
                    const rel = relativeTo(props.rootPath, p.path) || p.path;
                    return (
                      <li key={`${p.path}:${p.line}:${i}`}>
                        <Link href={`${props.editorHref}?file=${encodeURIComponent(rel)}`}>{rel}</Link>
                        {p.line > 0 ? `:${p.line}` : ''} — {problemLabel(p)}
                      </li>
                    );
                  })}
                </ul>
              </Alert>
            ) : null}
            {outdatedSelected.length ? (
              <Alert tone="warn" title="Outdated drafts selected">
                Remove them from the selection or open each file, review the upstream change, and save a fresh
                draft before committing.
              </Alert>
            ) : null}
            {showWarningAck && !blockingErrors.length ? (
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={acknowledgeWarnings}
                  onChange={(e) => setAcknowledgeWarnings(e.target.checked)}
                  disabled={busy !== null}
                />
                <span>
                  <span className="title">Commit despite warnings</span>
                  <span className="fine-print">
                    Required when the server reports warnings (including hard-coded secrets).
                  </span>
                </span>
              </label>
            ) : null}
            <div className="actions commit-actions">
              <Button
                variant="primary"
                type="submit"
                loading={busy === 'commit'}
                disabled={!canCommit || needsWarningAck}
              >
                Commit
              </Button>
              <Button
                type="button"
                loading={busy === 'commit-push'}
                disabled={!canCommit || needsWarningAck}
                onClick={() => void commit(true)}
              >
                Commit &amp; Push
              </Button>
              {retained ? (
                <Button
                  type="button"
                  loading={busy === 'push'}
                  disabled={busy !== null}
                  onClick={() => void pushRetained()}
                >
                  Push {shortSha(retained.commitSha)}
                </Button>
              ) : null}
            </div>
          </form>
        )}
      </section>

      {props.changes.map((c) => {
        const rel = relativeTo(props.rootPath, c.path) || c.path;
        const checked = selectedPaths.has(c.path);
        return (
          <section key={c.path} className="card flush" aria-label={`Changes to ${rel}`}>
            <div className="change-head">
              <label className="check-row change-select">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(c.path)}
                  disabled={busy !== null}
                  aria-label={`Include ${rel} in commit`}
                />
                <span>
                  <Link className="mono" href={`${props.editorHref}?file=${encodeURIComponent(rel)}`}>
                    {rel}
                  </Link>{' '}
                  {c.isNew ? (
                    <span className="pill ok">New file</span>
                  ) : (
                    <span className="pill pending">Modified</span>
                  )}{' '}
                  {c.outdated ? <span className="pill failed">Changed upstream</span> : null}
                  {checked ? <span className="fine-print"> Included in commit</span> : null}
                  <div className="fine-print">
                    Saved <LocalTime iso={c.updatedAt} />
                  </div>
                </span>
              </label>
              <ConfirmButton
                size="sm"
                label="Discard…"
                confirmLabel="Discard draft"
                loading={busy === 'discard' && discardPath === c.path}
                disabled={busy !== null && !(busy === 'discard' && discardPath === c.path)}
                onConfirm={() => discard(c.path)}
              />
            </div>
            {c.before === null && !c.isNew ? (
              <p className="fine-print change-head">The original version is no longer available locally.</p>
            ) : (
              <Diff before={c.before ?? ''} after={c.after} />
            )}
          </section>
        );
      })}
    </div>
  );
}
