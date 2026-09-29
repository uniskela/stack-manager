import type { Metadata } from 'next';
import { getContainer } from '@/server/container';
import { CredentialActions } from '@/ui/credential-actions';
import { LocalTime } from '@/ui/local-time';
import { Alert } from '@/ui/primitives/alert';
import { Section } from '@/ui/primitives/section';
import { StatusPill } from '@/ui/primitives/status-pill';
import { RemoveRepository, RepositoryActions } from '@/ui/repository-actions';
import { StackDiscovery } from '@/ui/source/stack-discovery';
import { orNotFound } from '../../../../_lib/session';

export const metadata: Metadata = { title: 'Repository' };

/** Overview tab: sync state, stacks, branches and credential. The header lives in the layout. */

export default async function RepositoryPage({
  params,
}: {
  params: Promise<{ workspaceId: string; repositoryId: string }>;
}) {
  const { workspaceId, repositoryId } = await params;
  const { repositories, stacks } = getContainer();
  const repo = await orNotFound(repositories.get(workspaceId, repositoryId));
  const branches = await repositories.branches(workspaceId, repositoryId);
  const suggestions = repo.headSha ? await stacks.suggest(workspaceId, repositoryId).catch(() => []) : [];
  const busy = repo.syncStatus === 'pending' || repo.syncStatus === 'syncing';
  const retrying = repo.sync?.status === 'pending' && repo.sync.attempts > 0;

  return (
    <div className="stack">
      {repo.syncStatus === 'error' && repo.lastSyncError ? (
        <Alert tone="error" title="Sync failed" role="alert">
          {repo.lastSyncError}
          {retrying ? ' Retrying automatically.' : ''}
        </Alert>
      ) : null}

      <Section
        id="repo-details"
        title="Source"
        footer={<RepositoryActions workspaceId={workspaceId} repositoryId={repo.id} busy={busy} />}
      >
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
      </Section>

      <Section
        id="repo-stacks"
        title="Stacks"
        description="Folders in this repository that contain a Compose file. Each one can be managed as a stack."
      >
        {repo.headSha ? (
          <StackDiscovery
            workspaceId={workspaceId}
            repositoryId={repo.id}
            suggestions={suggestions}
            autoAddStacks={repo.autoAddStacks}
          />
        ) : (
          <p className="muted">Stacks can be added after the first successful fetch.</p>
        )}
      </Section>

      <Section id="repo-branches" title="Branches">
        {branches.length > 0 ? (
          <ul className="branch-list">
            {branches.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        ) : (
          <p className="muted">Branches appear after the first successful fetch.</p>
        )}
      </Section>

      {repo.credential ? (
        <Section id="repo-credential" title="Credential">
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
        </Section>
      ) : null}

      <Section
        id="repo-danger"
        title="Danger zone"
        description="Removes this connection and its local clone. The remote repository is not touched; saved credentials are kept."
      >
        <RemoveRepository workspaceId={workspaceId} repositoryId={repo.id} />
      </Section>
    </div>
  );
}
