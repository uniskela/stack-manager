import type { Metadata } from 'next';
import Link from 'next/link';
import { getContainer } from '@/server/container';
import { LocalTime } from '@/ui/local-time';
import { StatusPill } from '@/ui/status-pill';

export const metadata: Metadata = { title: 'Repositories' };

export default async function WorkspaceHome({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const repositories = await getContainer().repositories.list(workspaceId);

  if (repositories.length === 0) {
    return (
      <div className="card empty">
        <h1>Connect your Compose repository</h1>
        <p className="muted">
          stack-manager works from the Git repository that describes your stacks. Connect it over HTTPS; a
          read-only token is enough to start.
        </p>
        <div className="actions" style={{ justifyContent: 'center' }}>
          <Link className="btn primary" href={`/w/${workspaceId}/repositories/new`}>
            Connect repository
          </Link>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Repositories</h1>
          <p className="muted">
            Git remains the source of truth. These are the repositories this workspace mirrors.
          </p>
        </div>
        <Link className="btn" href={`/w/${workspaceId}/repositories/new`}>
          Connect repository
        </Link>
      </div>
      <ul className="list">
        {repositories.map((repo) => (
          <li key={repo.id}>
            <Link className="list-row" href={`/w/${workspaceId}/repositories/${repo.id}`}>
              <div className="grow">
                <div className="title truncate">{repo.name}</div>
                <div className="muted mono truncate">{repo.remoteUrl}</div>
              </div>
              <div className="muted" style={{ textAlign: 'right', fontSize: '0.85rem' }}>
                <StatusPill status={repo.syncStatus} />
                <div>
                  {repo.providerName} · <span className="mono">{repo.defaultBranch}</span>
                </div>
                <div>
                  Fetched <LocalTime iso={repo.lastFetchedAt} />
                </div>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
