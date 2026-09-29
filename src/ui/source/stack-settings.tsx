'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, ApiError } from '../api';
import { Field } from '../form';
import { Alert } from '../primitives/alert';
import { Button } from '../primitives/button';
import { ConfirmButton } from '../primitives/confirm-button';

export function StackSettingsForm(props: {
  workspaceId: string;
  stackId: string;
  name: string;
  composePath: string;
  composeCandidates: string[];
}) {
  const router = useRouter();
  const [name, setName] = useState(props.name);
  const [composePath, setComposePath] = useState(props.composePath);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const changed = name.trim() !== props.name || composePath !== props.composePath;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setStatus(null);
    setFields({});
    try {
      await api(`/api/workspaces/${props.workspaceId}/stacks/${props.stackId}`, {
        method: 'PATCH',
        body: { name, composePath },
      });
      setStatus({ kind: 'ok', text: 'Saved.' });
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError) {
        setStatus({ kind: 'error', text: err.message });
        setFields(err.fields);
      } else setStatus({ kind: 'error', text: 'Could not reach the server.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="form" onSubmit={submit} noValidate>
      <Field
        label="Name"
        name="name"
        value={name}
        onChange={setName}
        error={fields.name}
        required
        spellCheck
      />
      <div className="field">
        <label htmlFor="compose-path">Compose file</label>
        <select id="compose-path" value={composePath} onChange={(e) => setComposePath(e.target.value)}>
          {props.composeCandidates.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        {fields.composePath ? <div className="error-text">{fields.composePath}</div> : null}
      </div>
      <div className="actions">
        <Button type="submit" variant="primary" disabled={!changed || !name.trim()} loading={busy}>
          Save
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

export function DeleteStack(props: { workspaceId: string; stackId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="stack">
      <ConfirmButton
        label="Remove stack…"
        confirmLabel="Confirm remove"
        description="Only the stack record is removed. Files in Git and saved drafts are not touched."
        loading={busy}
        onConfirm={async () => {
          setBusy(true);
          setError(null);
          try {
            await api(`/api/workspaces/${props.workspaceId}/stacks/${props.stackId}`, { method: 'DELETE' });
            router.replace(`/w/${props.workspaceId}/stacks`);
            router.refresh();
          } catch (err) {
            setError(err instanceof ApiError ? err.message : 'Could not reach the server.');
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
