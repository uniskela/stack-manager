'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, ApiError } from './api';

type TestResult = { ok: true; branchCount: number } | { ok: false; message: string };

/** Sync / test / remove controls. Polls for fresh state while a sync is queued or running. */
export function RepositoryActions(props: { workspaceId: string; repositoryId: string; busy: boolean }) {
  const router = useRouter();
  const base = `/api/workspaces/${props.workspaceId}/repositories/${props.repositoryId}`;
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!props.busy) return;
    const t = setInterval(() => router.refresh(), 2000);
    return () => clearInterval(t);
  }, [props.busy, router]);

  async function run(label: string, fn: () => Promise<void>) {
    setPending(label);
    setMessage(null);
    try {
      await fn();
    } catch (err) {
      setMessage({
        kind: 'error',
        text: err instanceof ApiError ? err.message : 'Could not reach the server.',
      });
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="stack">
      <div className="actions">
        <button
          className="btn"
          type="button"
          disabled={pending !== null || props.busy}
          onClick={() =>
            run('sync', async () => {
              await api(`${base}/sync`, { method: 'POST' });
              router.refresh();
            })
          }
        >
          {props.busy ? 'Syncing…' : 'Fetch now'}
        </button>
        <button
          className="btn"
          type="button"
          disabled={pending !== null}
          onClick={() =>
            run('test', async () => {
              const { result } = await api<{ result: TestResult }>(`${base}/test`, { method: 'POST' });
              setMessage(
                result.ok
                  ? { kind: 'ok', text: `Connection OK · ${result.branchCount} branches visible.` }
                  : { kind: 'error', text: result.message },
              );
              router.refresh();
            })
          }
        >
          {pending === 'test' ? 'Testing…' : 'Test connection'}
        </button>
        {!confirmDelete ? (
          <button
            className="btn danger"
            type="button"
            disabled={pending !== null}
            onClick={() => setConfirmDelete(true)}
          >
            Remove…
          </button>
        ) : (
          <>
            <button
              className="btn danger"
              type="button"
              disabled={pending !== null}
              onClick={() =>
                run('delete', async () => {
                  await api(base, { method: 'DELETE' });
                  router.replace(`/w/${props.workspaceId}`);
                  router.refresh();
                })
              }
            >
              Confirm remove
            </button>
            <button className="btn" type="button" onClick={() => setConfirmDelete(false)}>
              Cancel
            </button>
          </>
        )}
      </div>
      {confirmDelete ? (
        <p className="muted" style={{ fontSize: '0.88rem' }}>
          Removes this connection and its local clone. The remote repository is not touched; saved credentials
          are kept.
        </p>
      ) : null}
      {message ? (
        <div className={`alert ${message.kind}`} role="status">
          {message.text}
        </div>
      ) : null}
    </div>
  );
}
