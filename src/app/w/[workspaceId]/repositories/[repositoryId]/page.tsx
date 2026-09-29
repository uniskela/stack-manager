import type { Metadata } from 'next';
import Link from 'next/link';
import { getContainer } from '@/server/container';
import { CredentialActions } from '@/ui/credential-actions';
import { LocalTime } from '@/ui/local-time';
import { RepositoryActions } from '@/ui/repository-actions';
import { StatusPill } from '@/ui/status-pill';
import { orNotFound } from '../../../../_lib/session';

export const metadata: Metadata = { title: 'Repository' };

export default async function RepositoryPage({
  params,
}: {
  params: Promise<{ workspaceId: string; repositoryId: string }>;
}) {
  const { workspaceId, repositoryId } = await params;
  const { repositories } = getContainer();
  const repo = await orNotFound(repositories.get(workspaceId, repositoryId));
  const branches = await repositories.branches(workspaceId, repositoryId);
  const busy = repo.syncStatus === 'pending' || repo.syncStatus === 'syncing';
  const retrying = repo.sync?.status === 'pending' && repo.sync.attempts > 0;

  return (
    <>
      <p style={{ marginBottom: '0.5rem' }}>
        <Link href={`/w/${workspaceId}`}>← Repositories</Link>
      </p>
      <div className="page-head">
        <div style={{ minWidth: 0 }}>
          <h1 className="truncate">{repo.name}</h1>
          <p className="muted mono truncate" style={{ marginBottom: 0 }}>
            {repo.remoteUrl}
          </p>
        </div>
        <StatusPill status={repo.syncStatus} />
      </div>

      {repo.syncStatus === 'error' && repo.lastSyncError ? (
        <div className="alert error" role="alert" style={{ marginBottom: '1rem' }}>
          {repo.lastSyncError}
          {retrying ? ' Retrying automatically.' : ''}
        </div>
      ) : null}

      <section className="card" aria-labelledby="repo-details">
        <h2 id="repo-details">Source</h2>
        <dl className="meta-grid">
          <dt>Provider</dt>
          <dd>{repo.providerName}</dd>
          <dt>Default branch</dt>
          <dd className="mono">{repo.defaultBranch}</dd>
          <dt>Head</dt>
          <dd className="mono">
            {repo.headSha ? repo.headSha.slice(0, 12) : <span className="muted">Not fetched yet</span>}
          </dd>
          <dt>Last fetched</dt>
          <dd>
            <LocalTime iso={repo.lastFetchedAt} />
          </dd>
          <dt>Access</dt>
          <dd>
            {repo.credential
              ? `${repo.credential.label} (${repo.credential.hint})`
              : 'Public (no credential)'}
          </dd>
        </dl>
        <div style={{ marginTop: '1rem' }}>
          <RepositoryActions workspaceId={workspaceId} repositoryId={repo.id} busy={busy} />
        </div>
      </section>

      <section className="card" aria-labelledby="repo-branches">
        <h2 id="repo-branches">Branches</h2>
        {branches.length > 0 ? (
          <ul className="branch-list">
            {branches.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        ) : (
          <p className="muted">Branches appear after the first successful fetch.</p>
        )}
      </section>

      {repo.credential ? (
        <section className="card" aria-labelledby="repo-credential">
          <h2 id="repo-credential">Credential</h2>
          <p className="muted">
            {repo.credential.label} · <span className="mono">{repo.credential.hint}</span>
            {repo.credential.lastTestStatus ? (
              <>
                {' '}
                · <StatusPill status={repo.credential.lastTestStatus} />
              </>
            ) : null}
          </p>
          <CredentialActions workspaceId={workspaceId} credentialId={repo.credential.id} />
        </section>
      ) : null}
    </>
  );
}
