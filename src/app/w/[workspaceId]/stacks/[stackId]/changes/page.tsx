import type { Metadata } from 'next';
import { getContainer } from '@/server/container';
import { ChangesView } from '@/ui/source/changes-view';
import { requireSession } from '@/app/_lib/session';

export const metadata: Metadata = { title: 'Changes' };

export default async function StackChangesPage({
  params,
}: {
  params: Promise<{ workspaceId: string; stackId: string }>;
}) {
  const { workspaceId, stackId } = await params;
  const session = await requireSession();
  const { stacks, source, auth } = getContainer();
  const stack = await stacks.get(workspaceId, stackId);
  const [changes, identity] = await Promise.all([
    source.changes(workspaceId, stack.repository.id, stack.rootPath),
    auth.getGitIdentity(session.user.id),
  ]);
  return (
    <ChangesView
      key={changes.map((c) => c.path).join('\0')}
      workspaceId={workspaceId}
      repositoryId={stack.repository.id}
      apiBase={`/api/workspaces/${workspaceId}/stacks/${stackId}`}
      rootPath={stack.rootPath}
      changes={changes}
      editorHref={`/w/${workspaceId}/stacks/${stackId}`}
      branch={stack.repository.defaultBranch}
      gitIdentity={identity}
      composePath={stack.composePath}
    />
  );
}
