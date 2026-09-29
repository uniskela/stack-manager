import { FolderGit2, Plus } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { getContainer } from '@/server/container';
import { LocalTime } from '@/ui/local-time';
import { ButtonLink } from '@/ui/primitives/button';
import { EmptyState } from '@/ui/primitives/empty-state';
import { PageHeader } from '@/ui/primitives/page-header';
import { StatusPill } from '@/ui/primitives/status-pill';

export const metadata: Metadata = { title: 'Repositories' };

export default async function WorkspaceHome({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const repositories = await getContainer().repositories.list(workspaceId);
  const connectHref = `/w/${workspaceId}/repositories/new`;

  if (repositories.length === 0) {
    return (
      <EmptyState
        icon={FolderGit2}
        headingLevel={1}
        title="Connect your Compose repository"
        actions={
          <ButtonLink variant="primary" href={connectHref}>
            Connect repository
          </ButtonLink>
        }
      >
        stack-manager works from the Git repository that describes your stacks. Connect it over HTTPS; a
        read-only token is enough to start.
      </EmptyState>
    );
  }

  return (
    <>
      <PageHeader
        title="Repositories"
        description="Git remains the source of truth. These are the repositories this workspace mirrors."
        actions={
          <ButtonLink href={connectHref} icon={<Plus className="icon" aria-hidden="true" />}>
            Connect repository
          </ButtonLink>
        }
      />
      <ul className="list">
        {repositories.map((repo) => (
          <li key={repo.id}>
            <Link className="list-row stack-on-mobile" href={`/w/${workspaceId}/repositories/${repo.id}`}>
              <div className="grow">
                <div className="title truncate">{repo.name}</div>
                <div className="muted mono truncate">{repo.remoteUrl}</div>
              </div>
              <div className="list-row-meta">
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
