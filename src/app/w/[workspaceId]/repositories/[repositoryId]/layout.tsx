import { getContainer } from '@/server/container';
import { Breadcrumbs } from '@/ui/primitives/breadcrumbs';
import { PageHeader } from '@/ui/primitives/page-header';
import { StatusPill } from '@/ui/primitives/status-pill';
import { RepositoryTabs } from '@/ui/source/repository-tabs';
import { orNotFound } from '../../../../_lib/session';

export default async function RepositoryLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ workspaceId: string; repositoryId: string }>;
}) {
  const { workspaceId, repositoryId } = await params;
  const { repositories, source } = getContainer();
  const repo = await orNotFound(repositories.get(workspaceId, repositoryId));
  const drafts = repo.headSha ? await source.countDrafts(repo.id, '') : 0;

  return (
    <div className="stack">
      <div className="stack-head">
        <PageHeader
          breadcrumbs={
            <Breadcrumbs
              items={[
                { label: 'Repositories', href: `/w/${workspaceId}/repositories` },
                { label: repo.name },
              ]}
            />
          }
          title={repo.name}
          status={<StatusPill status={repo.syncStatus} />}
          description={<div className="mono truncate">{repo.remoteUrl}</div>}
        />
        <RepositoryTabs base={`/w/${workspaceId}/repositories/${repo.id}`} drafts={drafts} />
      </div>
      {children}
    </div>
  );
}
