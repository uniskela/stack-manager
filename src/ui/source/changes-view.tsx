'use client';

import { structuredPatch } from 'diff';
import { GitCompareArrows } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { relativeTo } from '@/shared/source/paths';
import type { ChangeView } from '@/shared/source/types';
import { api, ApiError } from '../api';
import { LocalTime } from '../local-time';
import { Alert } from '../primitives/alert';
import { ConfirmButton } from '../primitives/confirm-button';
import { EmptyState } from '../primitives/empty-state';
import { UnifiedDiff } from './unified-diff';

function Diff({ before, after }: { before: string; after: string }) {
  const patch = structuredPatch('before', 'after', before, after, '', '', { context: 3 });
  return <UnifiedDiff hunks={patch.hunks} />;
}

/** Review of draft changes in a stack, as unified diffs against the version each draft started from. */
export function ChangesView(props: {
  workspaceId: string;
  /** Source API of the scope (see StackEditorProps.apiBase). */
  apiBase: string;
  rootPath: string;
  changes: ChangeView[];
  editorHref: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (props.changes.length === 0) {
    return (
      <EmptyState icon={GitCompareArrows} title="No draft changes">
        Edits you save in the Editor or Docs appear here for review before they are committed.
      </EmptyState>
    );
  }

  const discard = async (path: string) => {
    setBusy(path);
    setError(null);
    try {
      await api(`${props.apiBase}/drafts?path=${encodeURIComponent(path)}`, {
        method: 'DELETE',
      });
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="stack">
      <Alert tone="info" title="Drafts are stored on this server">
        Committing and pushing drafts to Git arrives in the next update. Until then, drafts are kept safely in
        stack-manager and never leave this server.
      </Alert>
      {error ? (
        <Alert tone="error" role="alert">
          {error}
        </Alert>
      ) : null}
      {props.changes.map((c) => {
        const rel = relativeTo(props.rootPath, c.path) || c.path;
        return (
          <section key={c.path} className="card flush" aria-label={`Changes to ${rel}`}>
            <div className="change-head">
              <div>
                <Link className="mono" href={`${props.editorHref}?file=${encodeURIComponent(rel)}`}>
                  {rel}
                </Link>{' '}
                {c.isNew ? (
                  <span className="pill ok">New file</span>
                ) : (
                  <span className="pill pending">Modified</span>
                )}{' '}
                {c.outdated ? <span className="pill failed">Changed upstream</span> : null}
                <div className="fine-print">
                  Saved <LocalTime iso={c.updatedAt} />
                </div>
              </div>
              <ConfirmButton
                size="sm"
                label="Discard…"
                confirmLabel="Discard draft"
                loading={busy === c.path}
                disabled={busy !== null && busy !== c.path}
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
