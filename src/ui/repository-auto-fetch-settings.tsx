'use client';

import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { api, ApiError } from './api';
import { Alert } from './primitives/alert';
import { Button } from './primitives/button';

const intervals = [
  [5, 'Every 5 minutes'],
  [15, 'Every 15 minutes'],
  [30, 'Every 30 minutes'],
  [60, 'Every hour'],
  [360, 'Every 6 hours'],
  [720, 'Every 12 hours'],
  [1440, 'Every 24 hours'],
] as const;

type Settings = {
  autoFetchEnabled: boolean;
  autoFetchIntervalMinutes: number | null;
  autoFetchPolicy: {
    enabled: boolean;
    disabledReason: 'worker' | 'server' | 'repository' | null;
    intervalMinutes: number;
    serverIntervalMinutes: number;
  };
};

export function RepositoryAutoFetchSettings(
  props: Readonly<{
    workspaceId: string;
    repositoryId: string;
    settings: Settings;
  }>,
) {
  const router = useRouter();
  const id = useId();
  const [saved, setSaved] = useState(props.settings);
  const [enabled, setEnabled] = useState(saved.autoFetchEnabled);
  const initial = saved.autoFetchIntervalMinutes;
  let initialOption = 'default';
  if (initial !== null) initialOption = intervals.some(([n]) => n === initial) ? String(initial) : 'custom';
  const [interval, setInterval] = useState(initialOption);
  const [custom, setCustom] = useState(String(initial ?? 15));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState(false);
  const operatorDisabled =
    saved.autoFetchPolicy.disabledReason === 'worker' || saved.autoFetchPolicy.disabledReason === 'server';

  let policyText = 'Automatic fetching is off for this repository.';
  if (operatorDisabled) policyText = 'Automatic fetching is disabled by the server administrator.';
  else if (saved.autoFetchPolicy.enabled)
    policyText = `Automatically checks every ${saved.autoFetchPolicy.intervalMinutes} minutes.`;

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setNotice(false);
    let intervalMinutes: number | null = null;
    if (interval !== 'default') intervalMinutes = Number(interval === 'custom' ? custom : interval);
    try {
      const { repository } = await api<{ repository: Settings }>(
        `/api/workspaces/${props.workspaceId}/repositories/${props.repositoryId}`,
        {
          method: 'PATCH',
          body: {
            autoFetchEnabled: enabled,
            autoFetchIntervalMinutes: intervalMinutes,
          },
        },
      );
      setSaved(repository);
      setNotice(true);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="form" onSubmit={save} aria-busy={saving}>
      {operatorDisabled ? (
        <Alert tone="info">
          Automatic fetching is disabled by the server administrator. Repository settings are saved but will
          not take effect until server fetching is enabled.
        </Alert>
      ) : null}
      <label className="check-row">
        <input
          type="checkbox"
          checked={enabled}
          disabled={saving}
          onChange={(e) => {
            setEnabled(e.target.checked);
            setNotice(false);
          }}
        />
        <span>Automatically check for changes</span>
      </label>
      <div className="field">
        <label htmlFor={`${id}-interval`}>Check interval</label>
        <select
          id={`${id}-interval`}
          value={interval}
          disabled={saving}
          onChange={(e) => {
            setInterval(e.target.value);
            setNotice(false);
          }}
        >
          <option value="default">
            Use server default ({saved.autoFetchPolicy.serverIntervalMinutes} minutes)
          </option>
          {intervals.map(([minutes, label]) => (
            <option key={minutes} value={minutes}>
              {label}
            </option>
          ))}
          <option value="custom">Custom interval</option>
        </select>
      </div>
      {interval === 'custom' ? (
        <div className="field">
          <label htmlFor={`${id}-custom`}>Custom interval (minutes)</label>
          <input
            id={`${id}-custom`}
            type="number"
            min={5}
            max={1440}
            step={1}
            required
            value={custom}
            disabled={saving}
            aria-describedby={`${id}-hint`}
            onChange={(e) => {
              setCustom(e.target.value);
              setNotice(false);
            }}
          />
          <div className="hint" id={`${id}-hint`}>
            Use a whole number from 5 to 1440.
          </div>
        </div>
      ) : null}
      <p className="muted">
        <strong>Saved effective policy: </strong>
        {policyText}
        {saved.autoFetchIntervalMinutes === null ? ' Uses the server default interval.' : ''}
      </p>
      <p className="hint">
        Changes apply on the next scheduler tick. Pending and running fetches continue, including retries.
        Fetch now and post-push refresh remain available. Fetching does not deploy stacks or report their
        health.
      </p>
      <div className="actions">
        <Button type="submit" loading={saving}>
          {saving ? 'Saving…' : 'Save settings'}
        </Button>
      </div>
      {error ? (
        <Alert tone="error" role="alert">
          {error}
        </Alert>
      ) : null}
      {notice ? (
        <Alert tone="ok" role="status">
          Automatic fetching settings saved.
        </Alert>
      ) : null}
    </form>
  );
}
