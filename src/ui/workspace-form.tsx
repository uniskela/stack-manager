'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, ApiError } from './api';
import { Field, FormError } from './form';
import { Button } from './primitives/button';

export function CreateWorkspaceForm() {
  const router = useRouter();
  const [name, setName] = useState('Homelab');
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { workspace } = await api<{ workspace: { id: string } }>('/api/workspaces', {
        method: 'POST',
        body: { name },
      });
      router.replace(`/w/${workspace.id}/repositories/new?onboarding=1`);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setFields(err.fields);
      } else setError('Could not reach the server.');
      setBusy(false);
    }
  }

  return (
    <form className="form" onSubmit={submit} noValidate>
      <FormError message={error} />
      <Field
        label="Workspace name"
        name="name"
        value={name}
        onChange={setName}
        error={fields.name}
        hint="Usually one per Git-backed Compose estate, e.g. “Homelab” or “Production”."
        required
        autoFocus
        spellCheck
      />
      <div className="actions">
        <Button variant="primary" type="submit" disabled={!name.trim()} loading={busy}>
          {busy ? 'Creating…' : 'Continue'}
        </Button>
      </div>
    </form>
  );
}

export function RenameWorkspaceForm({
  workspaceId,
  initialName,
}: {
  workspaceId: string;
  initialName: string;
}) {
  const router = useRouter();
  const [name, setName] = useState(initialName);
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setStatus(null);
    try {
      await api(`/api/workspaces/${workspaceId}`, { method: 'PATCH', body: { name } });
      setStatus({ kind: 'ok', text: 'Saved.' });
      router.refresh();
    } catch (err) {
      setStatus({
        kind: 'error',
        text: err instanceof ApiError ? err.message : 'Could not reach the server.',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="form" onSubmit={submit} noValidate>
      <Field label="Workspace name" name="name" value={name} onChange={setName} required spellCheck />
      <div className="actions">
        <Button type="submit" disabled={!name.trim() || name === initialName} loading={busy}>
          Save name
        </Button>
        {status ? (
          <span role="status" className={status.kind === 'ok' ? 'muted' : 'error-text'}>
            {status.text}
          </span>
        ) : null}
      </div>
    </form>
  );
}
