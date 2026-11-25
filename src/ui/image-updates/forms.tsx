'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import type { WudBinding } from '@/shared/image-updates';
import { api, ApiError } from '@/ui/api';
import { Field, FormError } from '@/ui/form';
import { LocalTime } from '@/ui/local-time';
import { Alert } from '@/ui/primitives/alert';
import { Button } from '@/ui/primitives/button';
import { ConfirmButton } from '@/ui/primitives/confirm-button';

interface Connection {
  baseUrl: string;
  revision: string;
  lastSuccessAt: string;
  lastError: 'auth' | 'unavailable' | null;
}

function useImageUpdateAction() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      router.refresh();
    } catch (error) {
      setError(error instanceof ApiError ? error.message : 'Could not reach Stack Manager.');
    } finally {
      setBusy(false);
    }
  }

  return { busy, error, run };
}

export function WudConnectionForm({
  workspaceId,
  connection,
}: Readonly<{
  workspaceId: string;
  connection: Connection | null;
}>) {
  const endpoint = `/api/workspaces/${workspaceId}/image-updates`;
  const [url, setUrl] = useState(connection?.baseUrl ?? '');
  const [token, setToken] = useState('');
  const [saved, setSaved] = useState(false);
  const { busy, error, run } = useImageUpdateAction();

  function submit(e: FormEvent) {
    e.preventDefault();
    setSaved(false);
    void run(async () => {
      await api(endpoint, {
        method: 'PUT',
        body: { baseUrl: url, token, expectedRevision: connection?.revision ?? null },
      });
      setSaved(true);
      setToken('');
    });
  }

  return (
    <form className="form" method="post" action={endpoint} onSubmit={submit} aria-labelledby="wud-connection">
      <Field
        label="WUD URL"
        name="baseUrl"
        type="url"
        value={url}
        onChange={setUrl}
        required
        inputMode="url"
        hint="Enter the HTTPS base URL that Stack Manager can reach."
      />
      <Field
        label="WUD read token"
        name="token"
        type="password"
        value={token}
        onChange={setToken}
        required
        autoComplete="new-password"
        hint="Create an API token with the read scope in WUD."
      />
      <div className="actions">
        <Button type="submit" variant="primary" loading={busy}>
          Test and save
        </Button>
        {connection ? (
          <ConfirmButton
            label="Disconnect…"
            confirmLabel="Disconnect WUD"
            description="This removes the saved token and snapshot. Stack mappings are kept."
            disabled={busy}
            onConfirm={() =>
              run(async () => {
                await api(endpoint, { method: 'DELETE', body: { expectedRevision: connection.revision } });
                setSaved(false);
                setToken('');
              })
            }
          />
        ) : null}
      </div>
      {saved ? (
        <p>
          <output>WUD connection saved.</output>
        </p>
      ) : null}
      <FormError message={error} />
    </form>
  );
}

export function WudRefresh({
  workspaceId,
  connection,
  refreshing,
  workerEnabled,
}: Readonly<{
  workspaceId: string;
  connection: Connection;
  refreshing: boolean;
  workerEnabled: boolean;
}>) {
  const router = useRouter();
  const { busy, error, run } = useImageUpdateAction();

  useEffect(() => {
    if (!refreshing) return;
    const timer = setInterval(() => router.refresh(), 2000);
    return () => clearInterval(timer);
  }, [refreshing, router]);

  const endpoint = `/api/workspaces/${workspaceId}/image-updates/refresh`;
  return (
    <div className="stack">
      <div className="actions">
        <Button
          loading={refreshing || busy}
          disabled={!workerEnabled}
          onClick={() => void run(() => api(endpoint, { method: 'POST' }))}
        >
          {refreshing ? 'Refreshing WUD…' : 'Refresh from WUD'}
        </Button>
        <output className="muted">
          Last read from WUD <LocalTime iso={connection.lastSuccessAt} />
        </output>
      </div>
      {!workerEnabled ? <p className="muted">Refresh requires the background worker.</p> : null}
      {connection.lastError ? (
        <Alert tone="warn">
          {connection.lastError === 'auth' ? (
            <>
              WUD refused the read token.{' '}
              <Link href={`/w/${workspaceId}/settings/wud#wud-connection`}>
                Replace the token in WUD settings
              </Link>
              .
            </>
          ) : (
            'The last refresh could not read WUD. Check that Stack Manager can reach the WUD HTTPS URL, then choose Refresh from WUD.'
          )}
        </Alert>
      ) : null}
      <FormError message={error} />
    </div>
  );
}

export function WudBindingForm({
  workspaceId,
  stackId,
  binding,
}: Readonly<{
  workspaceId: string;
  stackId: string;
  binding: WudBinding | null;
}>) {
  const [watcher, setWatcher] = useState(binding?.watcher ?? '');
  const [project, setProject] = useState(binding?.project ?? '');
  const [message, setMessage] = useState<string | null>(null);
  const { busy, error, run } = useImageUpdateAction();
  const endpoint = `/api/workspaces/${workspaceId}/stacks/${stackId}/image-updates`;

  function submit(e: FormEvent) {
    e.preventDefault();
    setMessage(null);
    void run(async () => {
      await api(endpoint, { method: 'PUT', body: { watcher, project } });
      setMessage('Stack mapping saved.');
    });
  }

  return (
    <form className="form" method="post" action={endpoint} onSubmit={submit} aria-labelledby="wud-mapping">
      <Field
        label="Docker host in WUD"
        name="watcher"
        value={watcher}
        onChange={setWatcher}
        required
        hint="Enter the watcher name WUD uses for this Docker host."
      />
      <Field
        label="Deployed Compose project"
        name="project"
        value={project}
        onChange={setProject}
        required
        hint="Enter the Compose project name WUD shows for the running services."
      />
      <div className="actions">
        <Button type="submit" variant="primary" loading={busy}>
          Save WUD match
        </Button>
        {binding ? (
          <Button
            disabled={busy}
            onClick={() => {
              setMessage(null);
              void run(async () => {
                await api(endpoint, { method: 'DELETE' });
                setWatcher('');
                setProject('');
                setMessage('Stack mapping removed.');
              });
            }}
          >
            Unlink from WUD
          </Button>
        ) : null}
      </div>
      {message ? (
        <p>
          <output>{message}</output>
        </p>
      ) : null}
      <FormError message={error} />
    </form>
  );
}
