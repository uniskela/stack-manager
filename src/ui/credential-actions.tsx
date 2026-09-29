'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, ApiError } from './api';
import { Field } from './form';

/** Replace-only secret rotation and deletion. The current secret is never shown or fetched. */
export function CredentialActions(props: {
  workspaceId: string;
  credentialId: string;
  allowDelete?: boolean;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<'idle' | 'replace' | 'delete'>('idle');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const base = `/api/workspaces/${props.workspaceId}/credentials/${props.credentialId}`;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      await api(`${base}/secret`, { method: 'PUT', body: { secret } });
      setSecret('');
      setMode('idle');
      setMessage({ kind: 'ok', text: 'Secret replaced. Run a connection test to verify it.' });
      router.refresh();
    } catch (err) {
      setMessage({
        kind: 'error',
        text: err instanceof ApiError ? err.message : 'Could not reach the server.',
      });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setMessage(null);
    try {
      await api(base, { method: 'DELETE' });
      router.refresh();
    } catch (err) {
      setMessage({
        kind: 'error',
        text: err instanceof ApiError ? err.message : 'Could not reach the server.',
      });
      setMode('idle');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      {mode === 'replace' ? (
        <form className="form" onSubmit={submit} noValidate>
          <Field
            label="New secret"
            name="secret"
            type="password"
            value={secret}
            onChange={setSecret}
            hint="Stored encrypted. It will not be shown again."
            autoComplete="off"
            required
            autoFocus
          />
          <div className="actions">
            <button className="btn primary small" type="submit" disabled={busy || !secret.trim()}>
              {busy ? 'Saving…' : 'Replace secret'}
            </button>
            <button className="btn small" type="button" onClick={() => (setMode('idle'), setSecret(''))}>
              Cancel
            </button>
          </div>
        </form>
      ) : mode === 'delete' ? (
        <div className="actions">
          <button className="btn danger small" type="button" disabled={busy} onClick={remove}>
            Confirm delete
          </button>
          <button className="btn small" type="button" onClick={() => setMode('idle')}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="actions">
          <button className="btn small" type="button" onClick={() => setMode('replace')}>
            Replace secret…
          </button>
          {props.allowDelete ? (
            <button className="btn danger small" type="button" onClick={() => setMode('delete')}>
              Delete…
            </button>
          ) : null}
        </div>
      )}
      {message ? (
        <div className={`alert ${message.kind}`} role="status">
          {message.text}
        </div>
      ) : null}
    </div>
  );
}
