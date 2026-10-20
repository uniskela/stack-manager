'use client';

import { RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, ApiError } from './api';
import { Alert } from './primitives/alert';
import { Button } from './primitives/button';

/** Convenience action only for single-repository workspaces; never triggers a deployment. */
export function DashboardFetchAction({
  workspaceId,
  repositoryId,
}: {
  workspaceId: string;
  repositoryId: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function fetchNow() {
    setPending(true);
    setError(null);
    try {
      await api(`/api/workspaces/${workspaceId}/repositories/${repositoryId}/sync`, { method: 'POST' });
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not request a repository fetch.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="dashboard-fetch-control">
      <Button
        type="button"
        icon={<RefreshCw className="icon" aria-hidden="true" />}
        loading={pending}
        onClick={() => void fetchNow()}
      >
        {pending ? 'Requesting…' : 'Fetch now'}
      </Button>
      {error ? <Alert tone="error" role="alert">{error}</Alert> : null}
    </div>
  );
}
