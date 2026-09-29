'use client';

import { Layers, Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, ApiError } from '../api';
import { Field } from '../form';
import { Alert } from '../primitives/alert';
import { Button } from '../primitives/button';

export interface Suggestion {
  rootPath: string;
  composePath: string;
  name: string;
  existingStackId: string | null;
}

/**
 * Assisted stack setup (docs/STACK_DISCOVERY.md): folders with a Compose file are suggested, and
 * nothing is created until the operator ticks them. Folders can also be added by path.
 */
export function StackDiscovery(props: {
  workspaceId: string;
  repositoryId: string;
  suggestions: Suggestion[];
}) {
  const router = useRouter();
  const available = props.suggestions.filter((s) => !s.existingStackId);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [names, setNames] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualPath, setManualPath] = useState('');
  const [manualName, setManualName] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const endpoint = `/api/workspaces/${props.workspaceId}/repositories/${props.repositoryId}/stacks`;

  const toggle = (root: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(root)) next.delete(root);
      else next.add(root);
      return next;
    });

  async function addSelected() {
    setBusy(true);
    setError(null);
    const failures: string[] = [];
    for (const s of available.filter((x) => selected.has(x.rootPath))) {
      try {
        await api(endpoint, {
          method: 'POST',
          body: {
            rootPath: s.rootPath,
            composePath: s.composePath,
            name: names[s.rootPath]?.trim() || s.name,
          },
        });
      } catch (err) {
        failures.push(`${s.rootPath || '(root)'}: ${err instanceof ApiError ? err.message : 'failed'}`);
      }
    }
    setBusy(false);
    setSelected(new Set());
    if (failures.length) setError(failures.join(' '));
    router.refresh();
  }

  async function addManual(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFields({});
    try {
      const { stack } = await api<{ stack: { id: string } }>(endpoint, {
        method: 'POST',
        body: { rootPath: manualPath, name: manualName.trim() || undefined },
      });
      router.push(`/w/${props.workspaceId}/stacks/${stack.id}`);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setFields(err.fields);
      } else setError('Could not reach the server.');
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      {error ? (
        <Alert tone="error" role="alert">
          {error}
        </Alert>
      ) : null}
      {props.suggestions.length === 0 ? (
        <p className="muted">No Compose files were found in this repository.</p>
      ) : (
        <ul className="list">
          {props.suggestions.map((s) => {
            const id = `suggest-${s.rootPath || 'root'}`;
            return (
              <li key={s.rootPath} className="list-row wrap">
                {s.existingStackId ? (
                  <Layers className="icon muted" aria-hidden="true" />
                ) : (
                  <input
                    id={id}
                    type="checkbox"
                    checked={selected.has(s.rootPath)}
                    onChange={() => toggle(s.rootPath)}
                    aria-label={`Add ${s.rootPath || 'repository root'} as a stack`}
                  />
                )}
                <div className="grow">
                  <label className="title mono" htmlFor={s.existingStackId ? undefined : id}>
                    {s.rootPath || '(repository root)'}
                  </label>
                  <div className="list-row-sub mono">{s.composePath}</div>
                </div>
                {s.existingStackId ? (
                  <Link className="btn small" href={`/w/${props.workspaceId}/stacks/${s.existingStackId}`}>
                    Open stack
                  </Link>
                ) : selected.has(s.rootPath) ? (
                  <input
                    type="text"
                    aria-label={`Name for ${s.rootPath || 'repository root'}`}
                    value={names[s.rootPath] ?? s.name}
                    onChange={(e) => setNames((n) => ({ ...n, [s.rootPath]: e.target.value }))}
                    className="inline-input"
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <div className="actions">
        {available.length > 0 ? (
          <Button
            variant="primary"
            disabled={selected.size === 0}
            loading={busy && !manualOpen}
            onClick={addSelected}
            icon={<Plus className="icon" aria-hidden="true" />}
          >
            {selected.size > 1 ? `Add ${selected.size} stacks` : 'Add stack'}
          </Button>
        ) : null}
        <Button variant="ghost" onClick={() => setManualOpen((v) => !v)} aria-expanded={manualOpen}>
          Add a folder by path…
        </Button>
      </div>
      {manualOpen ? (
        <form className="form card" onSubmit={addManual} noValidate>
          <Field
            label="Folder"
            name="rootPath"
            value={manualPath}
            onChange={setManualPath}
            placeholder="apps/liftlog"
            hint="Relative to the repository root. Leave empty for the root itself. The folder must contain a Compose file."
            error={fields.rootPath ?? fields.composePath}
          />
          <Field
            label="Name (optional)"
            name="name"
            value={manualName}
            onChange={setManualName}
            error={fields.name}
            spellCheck
          />
          <div className="actions">
            <Button type="submit" variant="primary" loading={busy}>
              Add stack
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
