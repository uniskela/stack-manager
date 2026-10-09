'use client';

import { ChevronLeft, ChevronRight, Layers, ListPlus, Plus, Search } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
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

interface AddAllResult {
  added: number;
  existing: number;
  failed: { rootPath: string; message: string }[];
}

export const STACKS_PAGE_SIZE = 25;

const label = (s: Suggestion) => s.rootPath || '(repository root)';

/**
 * Stacks of one repository (docs/public/STACK_DISCOVERY.md). Every folder with a Compose file is listed; with
 * auto-add on (the default) they are registered after each fetch, otherwise the operator adds all of
 * them at once or picks some. Folders can also be added by path.
 */
export function StackDiscovery(props: {
  workspaceId: string;
  repositoryId: string;
  suggestions: Suggestion[];
  autoAddStacks: boolean;
}) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [names, setNames] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<'selected' | 'all' | 'auto' | 'manual' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [autoAdd, setAutoAdd] = useState(props.autoAddStacks);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualPath, setManualPath] = useState('');
  const [manualName, setManualName] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const base = `/api/workspaces/${props.workspaceId}/repositories/${props.repositoryId}`;
  const endpoint = `${base}/stacks`;

  const available = props.suggestions.filter((s) => !s.existingStackId);
  const managed = props.suggestions.length - available.length;
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q
      ? props.suggestions.filter(
          (s) => s.rootPath.toLowerCase().includes(q) || s.composePath.toLowerCase().includes(q),
        )
      : props.suggestions;
  }, [props.suggestions, query]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / STACKS_PAGE_SIZE));
  const current = Math.min(page, pageCount - 1);
  const start = current * STACKS_PAGE_SIZE;
  const visible = filtered.slice(start, start + STACKS_PAGE_SIZE);
  const visibleAvailable = visible.filter((s) => !s.existingStackId);
  const pageAllSelected =
    visibleAvailable.length > 0 && visibleAvailable.every((s) => selected.has(s.rootPath));

  const toggle = (root: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(root)) next.delete(root);
      else next.add(root);
      return next;
    });

  const togglePage = () =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const s of visibleAvailable) {
        if (pageAllSelected) next.delete(s.rootPath);
        else next.add(s.rootPath);
      }
      return next;
    });

  function report(result: AddAllResult) {
    const parts = [`Added ${result.added} stack${result.added === 1 ? '' : 's'}.`];
    if (result.failed.length) {
      setError(
        `${result.failed.length} could not be added: ` +
          result.failed.map((f) => `${f.rootPath || '(root)'} (${f.message})`).join(', '),
      );
    }
    setNotice(parts.join(' '));
  }

  async function addAll() {
    setBusy('all');
    setError(null);
    setNotice(null);
    try {
      const { result } = await api<{ result: AddAllResult }>(`${endpoint}/all`, { method: 'POST' });
      report(result);
      setSelected(new Set());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server.');
    }
    setBusy(null);
    router.refresh();
  }

  async function addSelected() {
    setBusy('selected');
    setError(null);
    setNotice(null);
    const failures: string[] = [];
    let added = 0;
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
        added++;
      } catch (err) {
        failures.push(`${s.rootPath || '(root)'}: ${err instanceof ApiError ? err.message : 'failed'}`);
      }
    }
    setBusy(null);
    setSelected(new Set());
    setNotice(`Added ${added} stack${added === 1 ? '' : 's'}.`);
    if (failures.length) setError(failures.join(' '));
    router.refresh();
  }

  async function changeAutoAdd(next: boolean) {
    setBusy('auto');
    setError(null);
    setNotice(null);
    try {
      await api(base, { method: 'PATCH', body: { autoAddStacks: next } });
      setAutoAdd(next);
      if (next && available.length > 0) {
        // Turning it on should not wait for the next fetch.
        const { result } = await api<{ result: AddAllResult }>(`${endpoint}/all`, { method: 'POST' });
        report(result);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server.');
    }
    setBusy(null);
    router.refresh();
  }

  async function addManual(e: React.FormEvent) {
    e.preventDefault();
    setBusy('manual');
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
      setBusy(null);
    }
  }

  return (
    <div className="stack">
      <label className="check-row">
        <input
          type="checkbox"
          checked={autoAdd}
          disabled={busy !== null}
          onChange={(e) => changeAutoAdd(e.target.checked)}
        />
        <span>
          <span className="title">Add new stacks automatically</span>
          <span className="list-row-sub">
            Every folder with a Compose file becomes a stack after each fetch. Removed folders keep their
            stack.
          </span>
        </span>
      </label>

      {error ? (
        <Alert tone="error" role="alert">
          {error}
        </Alert>
      ) : null}
      {notice && !error ? (
        <Alert tone="ok" role="status">
          {notice}
        </Alert>
      ) : null}

      {props.suggestions.length === 0 ? (
        <p className="muted">No Compose files were found in this repository.</p>
      ) : (
        <>
          <div className="discovery-toolbar">
            <p className="muted" aria-live="polite">
              {props.suggestions.length} Compose folder{props.suggestions.length === 1 ? '' : 's'} · {managed}{' '}
              managed
              {available.length ? ` · ${available.length} not added` : ''}
            </p>
            {props.suggestions.length > STACKS_PAGE_SIZE ? (
              <div className="search-field">
                <Search className="icon muted" aria-hidden="true" />
                <input
                  type="search"
                  aria-label="Filter folders"
                  placeholder="Filter folders"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setPage(0);
                  }}
                />
              </div>
            ) : null}
          </div>

          {visible.length === 0 ? (
            <p className="muted">No folders match “{query}”.</p>
          ) : (
            <ul className="list" aria-label="Compose folders">
              {visibleAvailable.length > 1 ? (
                <li className="list-row list-head">
                  <input id="suggest-page" type="checkbox" checked={pageAllSelected} onChange={togglePage} />
                  <label htmlFor="suggest-page" className="grow muted">
                    Select all on this page
                  </label>
                </li>
              ) : null}
              {visible.map((s) => {
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
                        {label(s)}
                      </label>
                      <div className="list-row-sub mono">{s.composePath}</div>
                    </div>
                    {s.existingStackId ? (
                      <Link
                        className="btn small"
                        href={`/w/${props.workspaceId}/stacks/${s.existingStackId}`}
                      >
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

          {pageCount > 1 ? (
            <nav className="pager" aria-label="Compose folder pages">
              <Button
                size="sm"
                variant="ghost"
                disabled={current === 0}
                onClick={() => setPage(current - 1)}
                icon={<ChevronLeft className="icon" aria-hidden="true" />}
              >
                Previous
              </Button>
              <span className="muted">
                {start + 1}–{Math.min(start + STACKS_PAGE_SIZE, filtered.length)} of {filtered.length}
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={current >= pageCount - 1}
                onClick={() => setPage(current + 1)}
              >
                Next
                <ChevronRight className="icon" aria-hidden="true" />
              </Button>
            </nav>
          ) : null}
        </>
      )}

      <div className="actions">
        {available.length > 0 ? (
          <Button
            variant="primary"
            loading={busy === 'all'}
            disabled={busy !== null}
            onClick={addAll}
            icon={<ListPlus className="icon" aria-hidden="true" />}
          >
            {available.length === 1 ? 'Add the new stack' : `Add all ${available.length} stacks`}
          </Button>
        ) : null}
        {selected.size > 0 ? (
          <Button
            loading={busy === 'selected'}
            disabled={busy !== null}
            onClick={addSelected}
            icon={<Plus className="icon" aria-hidden="true" />}
          >
            {selected.size > 1 ? `Add ${selected.size} selected` : 'Add selected'}
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
            placeholder="apps/wiki"
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
            <Button type="submit" variant="primary" loading={busy === 'manual'}>
              Add stack
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
