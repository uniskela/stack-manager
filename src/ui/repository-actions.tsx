'use client';

import { PlugZap, RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, ApiError } from './api';
import { Alert } from './primitives/alert';
import { Button } from './primitives/button';
import { ConfirmButton } from './primitives/confirm-button';

type TestResult = { ok: true; branchCount: number } | { ok: false; message: string };

const errorText = (err: unknown) => (err instanceof ApiError ? err.message : 'Could not reach the server.');

/** Sync / test controls. Polls for fresh state while a sync is queued or running. */
export function RepositoryActions(props: { workspaceId: string; repositoryId: string; busy: boolean }) {
  const router = useRouter();
  const base = `/api/workspaces/${props.workspaceId}/repositories/${props.repositoryId}`;
  const [pending, setPending] = useState<'sync' | 'test' | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => {
    if (!props.busy) return;
    const t = setInterval(() => router.refresh(), 2000);
    return () => clearInterval(t);
  }, [props.busy, router]);

  async function run(label: 'sync' | 'test', fn: () => Promise<void>) {
    setPending(label);
    setMessage(null);
    try {
      await fn();
    } catch (err) {
      setMessage({ kind: 'error', text: errorText(err) });
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="stack">
      <div className="actions">
        <Button
          loading={pending === 'sync' || props.busy}
          disabled={pending !== null}
          icon={<RefreshCw className="icon" aria-hidden="true" />}
          onClick={() =>
            run('sync', async () => {
              await api(`${base}/sync`, { method: 'POST' });
              router.refresh();
            })
          }
        >
          {props.busy ? 'Syncing…' : 'Fetch now'}
        </Button>
        <Button
          loading={pending === 'test'}
          disabled={pending !== null}
          icon={<PlugZap className="icon" aria-hidden="true" />}
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
        </Button>
      </div>
      {message ? (
        <Alert tone={message.kind} role="status">
          {message.text}
        </Alert>
      ) : null}
    </div>
  );
}

export function RemoveRepository(props: { workspaceId: string; repositoryId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="stack">
      <ConfirmButton
        label="Remove repository…"
        confirmLabel="Confirm remove"
        description="This cannot be undone from stack-manager. You can reconnect the repository later."
        loading={busy}
        onConfirm={async () => {
          setBusy(true);
          setError(null);
          try {
            await api(`/api/workspaces/${props.workspaceId}/repositories/${props.repositoryId}`, {
              method: 'DELETE',
            });
            router.replace(`/w/${props.workspaceId}`);
            router.refresh();
          } catch (err) {
            setError(errorText(err));
            setBusy(false);
          }
        }}
      />
      {error ? (
        <Alert tone="error" role="alert">
          {error}
        </Alert>
      ) : null}
    </div>
  );
}
