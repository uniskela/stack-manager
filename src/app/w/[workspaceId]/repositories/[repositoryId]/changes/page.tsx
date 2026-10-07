import type { Metadata } from 'next';
import { getContainer } from '@/server/container';
import { ChangesView } from '@/ui/source/changes-view';
import { requireSession } from '@/app/_lib/session';
import { NotFetched, repositorySourceApi } from '@/app/_lib/repository-source';

export const metadata: Metadata = { title: 'Changes' };

/** Every draft in the repository, including those made inside stack folders. */
export default async function RepositoryChangesPage({
  params,
}: {
  params: Promise<{ workspaceId: string; repositoryId: string }>;
}) {
  const { workspaceId, repositoryId } = await params;
  const session = await requireSession();
  const { repositories, source, auth } = getContainer();
  const repo = await repositories.get(workspaceId, repositoryId);
  if (!repo.headSha) return <NotFetched />;
  const [changes, identity] = await Promise.all([
    source.changes(workspaceId, repositoryId, ''),
    auth.getGitIdentity(session.user.id),
  ]);
  return (
    <div className="wide-page">
      <ChangesView
        key={repositoryId}
        workspaceId={workspaceId}
        repositoryId={repositoryId}
        apiBase={repositorySourceApi(workspaceId, repositoryId)}
        rootPath=""
        changes={changes}
        editorHref={`/w/${workspaceId}/repositories/${repositoryId}/files`}
        branch={repo.defaultBranch}
        gitIdentity={identity}
      />
    </div>
  );
}
