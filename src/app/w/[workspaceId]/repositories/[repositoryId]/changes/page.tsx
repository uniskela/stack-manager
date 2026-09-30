import type { Metadata } from 'next';
import { getContainer } from '@/server/container';
import { ChangesView } from '@/ui/source/changes-view';
import { NotFetched, repositorySourceApi } from '../../../../../_lib/repository-source';

export const metadata: Metadata = { title: 'Changes' };

/** Every draft in the repository, including those made inside stack folders. */
export default async function RepositoryChangesPage({
  params,
}: {
  params: Promise<{ workspaceId: string; repositoryId: string }>;
}) {
  const { workspaceId, repositoryId } = await params;
  const { repositories, source } = getContainer();
  const repo = await repositories.get(workspaceId, repositoryId);
  if (!repo.headSha) return <NotFetched />;
  const changes = await source.changes(workspaceId, repositoryId, '');
  return (
    <div className="wide-page">
      <ChangesView
        workspaceId={workspaceId}
        apiBase={repositorySourceApi(workspaceId, repositoryId)}
        rootPath=""
        changes={changes}
        editorHref={`/w/${workspaceId}/repositories/${repositoryId}/files`}
      />
    </div>
  );
}
