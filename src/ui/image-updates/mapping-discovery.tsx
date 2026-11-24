'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  MAX_WUD_MAPPINGS_PER_SAVE,
  type WudMappingDiscovery as Discovery,
  type WudMappingSaveResult,
} from '@/shared/image-updates';
import { api, ApiError } from '@/ui/api';
import { FormError } from '@/ui/form';
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
  const [error, setError] = useState<string | null>(null);
  const found = discovery?.suggestions.filter((item) => !stackId || item.stackId === stackId) ?? [];
  const displayed = found.slice(0, MAX_WUD_MAPPINGS_PER_SAVE);

  async function find() {
    setBusy('find');
    setError(null);
    setMessage('');
    setDiscovery(null);
    try {
      setDiscovery(await api<Discovery>(endpoint));
    } catch (error) {
      setError(error instanceof ApiError ? error.message : 'Could not find WUD matches.');
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    setBusy('save');
    setError(null);
    setMessage('');
    try {
      const { results } = await api<WudMappingSaveResult>(endpoint, {
        method: 'POST',
        body: { mappings: displayed.map(({ stackId, watcher, project }) => ({ stackId, watcher, project })) },
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
      setError(error instanceof ApiError ? error.message : 'Could not save WUD matches.');
    } finally {
      setBusy(null);
    }
  }

  const nothingFound = stackId
    ? 'No unique match for this stack. You can enter the WUD details manually.'
    : 'No unique matches found. Open a stack to enter its WUD details manually.';

  return (
    <div className="stack">
      <div className="actions">
        <Button onClick={() => void find()} loading={busy === 'find'} disabled={busy === 'save'}>
          Find WUD matches
        </Button>
      </div>
      {discovery && !displayed.length ? (
        <p className="muted">
          <output>{nothingFound}</output>
        </p>
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
              onClick={() => void save()}
              loading={busy === 'save'}
              disabled={busy === 'find'}
            >
              {displayed.length === 1 ? 'Save this match' : `Save ${displayed.length} matches`}
            </Button>
          </div>
        </>
      ) : null}
      {!stackId && discovery && (discovery.ambiguousCount > 0 || discovery.unmatchedCount > 0) ? (
        <p className="muted">
          {discovery.ambiguousCount ? `Multiple matches for ${discovery.ambiguousCount} stacks. ` : ''}
          {discovery.unmatchedCount ? `No matching WUD data for ${discovery.unmatchedCount} stacks.` : ''}
        </p>
      ) : null}
      <output>{message}</output>
      <FormError message={error} />
    </div>
  );
}
