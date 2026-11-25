'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import {
  MAX_WUD_MAPPINGS_PER_SAVE,
  type WudMappingCandidate,
  type WudMappingDiscovery as Discovery,
  type WudMappingSaveResult,
  type WudMappingSelection,
} from '@/shared/image-updates';
import { api, ApiError } from '@/ui/api';
import { FormError } from '@/ui/form';
import { Alert } from '@/ui/primitives/alert';
import { Button } from '@/ui/primitives/button';
import { TableWrap } from '@/ui/primitives/table-wrap';

export function WudMappingDiscovery({
  workspaceId,
  stackId,
  labelledBy,
}: Readonly<{ workspaceId: string; stackId?: string; labelledBy: string }>) {
  const router = useRouter();
  const endpoint = `/api/workspaces/${workspaceId}/image-updates/mappings`;
  const [discovery, setDiscovery] = useState<Discovery | null>(null);
  const [busy, setBusy] = useState<'find' | 'save' | null>(null);
  const [message, setMessage] = useState('');
  const [problem, setProblem] = useState<{ code?: string; message: string } | null>(null);
  const found = discovery?.suggestions.filter((item) => !stackId || item.stackId === stackId) ?? [];
  const displayed = found.slice(0, MAX_WUD_MAPPINGS_PER_SAVE);
  const choices = discovery?.choices ?? [];
  const ambiguousStacks = stackId ? [] : (discovery?.ambiguousStacks ?? []);

  async function find() {
    setBusy('find');
    setProblem(null);
    setMessage('');
    setDiscovery(null);
    try {
      const query = stackId ? `?stackId=${encodeURIComponent(stackId)}` : '';
      setDiscovery(await api<Discovery>(endpoint + query));
    } catch (error) {
      setProblem(error instanceof ApiError ? error : { message: 'Could not find WUD matches.' });
    } finally {
      setBusy(null);
    }
  }

  async function save(mappings: WudMappingSelection[], confirmChoice?: true) {
    setBusy('save');
    setProblem(null);
    setMessage('');
    try {
      const { results } = await api<WudMappingSaveResult>(endpoint, {
        method: 'POST',
        body: { mappings, confirmChoice },
      });
      const saved = results.filter((row) => row.status === 'saved').length;
      const processed = new Set(results.map((row) => row.stackId));
      setDiscovery(null);
      const remaining = found.filter((item) => !processed.has(item.stackId)).length;
      const skipped = results.length - saved;
      const summary = [`Saved ${saved} ${saved === 1 ? 'match' : 'matches'}.`];
      if (skipped) summary.push(`${skipped} could not be saved. Find matches again to retry.`);
      else if (remaining) summary.push('Find matches again to continue with the remaining stacks.');
      setMessage(summary.join(' '));
      if (saved) router.refresh();
    } catch (error) {
      setProblem(error instanceof ApiError ? error : { message: 'Could not save WUD matches.' });
    } finally {
      setBusy(null);
    }
  }

  const nothingFound = stackId
    ? 'No matching project found. Check that WUD reports this stack’s services and images, or enter the details manually.'
    : 'No automatic matches found.';

  return (
    <div className="stack">
      <div className="actions">
        <Button onClick={() => void find()} loading={busy === 'find'} disabled={busy === 'save'}>
          Find WUD matches
        </Button>
      </div>
      {discovery && !displayed.length && !choices.length && !ambiguousStacks.length ? (
        <p className="muted">
          <output>{nothingFound}</output>
        </p>
      ) : null}
      {stackId && choices.length > 0 ? (
        <WudMatchChoice
          choices={choices}
          disabled={busy !== null}
          saving={busy === 'save'}
          onSave={({ watcher, project }) => void save([{ stackId, watcher, project }], true)}
        />
      ) : null}
      {displayed.length > 0 ? (
        <>
          <TableWrap labelledBy={labelledBy}>
            <table className="simple">
              <thead>
                <tr>
                  <th scope="col">Stack in Git</th>
                  <th scope="col">Docker host in WUD</th>
                  <th scope="col">Deployed Compose project</th>
                  <th scope="col">Matching services</th>
                </tr>
              </thead>
              <tbody>
                {displayed.map(({ stackId, stackName, watcher, project, matchedServices }) => (
                  <tr key={stackId}>
                    <th scope="row">{stackName}</th>
                    <td>
                      <code>{watcher}</code>
                    </td>
                    <td>
                      <code>{project}</code>
                    </td>
                    <td>{matchedServices.join(', ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
          <div className="actions">
            <Button
              variant="primary"
              onClick={() =>
                void save(displayed.map(({ stackId, watcher, project }) => ({ stackId, watcher, project })))
              }
              loading={busy === 'save'}
              disabled={busy === 'find'}
            >
              {displayed.length === 1 ? 'Save this match' : `Save ${displayed.length} matches`}
            </Button>
          </div>
        </>
      ) : null}
      {ambiguousStacks.length > 0 ? (
        <div>
          <p>Open a stack to choose which WUD project it uses.</p>
          <ul>
            {ambiguousStacks.map(({ stackId, stackName }) => (
              <li key={stackId}>
                <Link href={`/w/${workspaceId}/stacks/${stackId}/image-updates#wud-mapping`}>
                  {stackName}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {!stackId && discovery && discovery.unmatchedCount > 0 ? (
        <p className="muted">
          No matching WUD data for {discovery.unmatchedCount}{' '}
          {discovery.unmatchedCount === 1 ? 'stack' : 'stacks'}.
        </p>
      ) : null}
      <output>{message}</output>
      {problem ? <WudMappingProblem workspaceId={workspaceId} problem={problem} /> : null}
    </div>
  );
}

function WudMatchChoice({
  choices,
  disabled,
  saving,
  onSave,
}: Readonly<{
  choices: WudMappingCandidate[];
  disabled: boolean;
  saving: boolean;
  onSave: (candidate: WudMappingCandidate) => void;
}>) {
  const id = useId();
  const [key, setKey] = useState('');
  const choice = choices.find((candidate) => candidateKey(candidate) === key);
  return (
    <div className="stack">
      <div className="field">
        <label htmlFor={id}>Choose the Docker host and Compose project</label>
        <select id={id} value={key} onChange={(event) => setKey(event.target.value)} disabled={disabled}>
          <option value="">Select a project</option>
          {choices.map((candidate) => (
            <option key={candidateKey(candidate)} value={candidateKey(candidate)}>
              {candidate.watcher} · {candidate.project}
            </option>
          ))}
        </select>
        {choice ? <p className="hint">Matching services · {choice.matchedServices.join(', ')}</p> : null}
      </div>
      <div className="actions">
        <Button
          variant="primary"
          disabled={!choice || disabled}
          loading={saving}
          onClick={() => choice && onSave(choice)}
        >
          Save chosen match
        </Button>
      </div>
    </div>
  );
}

const candidateKey = ({ watcher, project }: WudMappingCandidate) => watcher + ':' + project;

const recovery: Record<string, { section: string; label: string; instructions?: string } | undefined> = {
  wud_not_connected: { section: 'wud-connection', label: 'Connect WUD in Settings' },
  wud_auth_failed: { section: 'wud-connection', label: 'Replace the WUD read token' },
  wud_snapshot_stale: {
    section: 'wud-refresh',
    label: 'Open WUD refresh settings',
    instructions: 'Choose Refresh from WUD, then find matches again.',
  },
  wud_unavailable: {
    section: 'wud-refresh',
    label: 'Check the WUD connection',
    instructions: 'Check that Stack Manager can reach the WUD HTTPS URL, then choose Refresh from WUD.',
  },
};

function WudMappingProblem({
  workspaceId,
  problem,
}: Readonly<{ workspaceId: string; problem: { code?: string; message: string } }>) {
  const action = problem.code ? recovery[problem.code] : undefined;
  if (!action) return <FormError message={problem.message} />;
  return (
    <Alert tone="error" role="alert">
      <p>{problem.message}</p>
      {action.instructions ? <p>{action.instructions}</p> : null}
      <Link href={`/w/${workspaceId}/settings/wud#${action.section}`}>{action.label}</Link>
    </Alert>
  );
}
