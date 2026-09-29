'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, ApiError } from './api';
import { Field } from './form';
import { Alert } from './primitives/alert';
import { Button } from './primitives/button';
import { ConfirmButton } from './primitives/confirm-button';

/** Replace-only secret rotation and deletion. The current secret is never shown or fetched. */
export function CredentialActions(props: {
  workspaceId: string;
  credentialId: string;
  allowDelete?: boolean;
}) {
  const router = useRouter();
  const [replacing, setReplacing] = useState(false);
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const base = `/api/workspaces/${props.workspaceId}/credentials/${props.credentialId}`;
  const errorText = (err: unknown) => (err instanceof ApiError ? err.message : 'Could not reach the server.');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      await api(`${base}/secret`, { method: 'PUT', body: { secret } });
      setSecret('');
      setReplacing(false);
      setMessage({ kind: 'ok', text: 'Secret replaced. Run a connection test to verify it.' });
      router.refresh();
    } catch (err) {
      setMessage({ kind: 'error', text: errorText(err) });
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
      setMessage({ kind: 'error', text: errorText(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      {replacing ? (
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
            <Button variant="primary" size="sm" type="submit" disabled={!secret.trim()} loading={busy}>
              {busy ? 'Saving…' : 'Replace secret'}
            </Button>
            <Button size="sm" onClick={() => (setReplacing(false), setSecret(''))}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="actions">
          <Button size="sm" disabled={busy} onClick={() => setReplacing(true)}>
            Replace secret…
          </Button>
          {props.allowDelete ? (
            <ConfirmButton
              size="sm"
              label="Delete…"
              confirmLabel="Confirm delete"
              loading={busy}
              onConfirm={remove}
            />
          ) : null}
        </div>
      )}
      {message ? (
        <Alert tone={message.kind} role={message.kind === 'error' ? 'alert' : 'status'}>
          {message.text}
        </Alert>
      ) : null}
    </div>
  );
}
