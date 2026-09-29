import type { Metadata } from 'next';
import { getContainer } from '@/server/container';
import { ChangesView } from '@/ui/source/changes-view';

export const metadata: Metadata = { title: 'Changes' };

export default async function StackChangesPage({
  params,
}: {
  params: Promise<{ workspaceId: string; stackId: string }>;
}) {
  const { workspaceId, stackId } = await params;
  const { stacks, source } = getContainer();
  const stack = await stacks.get(workspaceId, stackId);
  const changes = await source.changes(workspaceId, stack.repository.id, stack.rootPath);
  return (
    <ChangesView
      workspaceId={workspaceId}
      stackId={stackId}
      rootPath={stack.rootPath}
      changes={changes}
      editorHref={`/w/${workspaceId}/stacks/${stackId}`}
    />
  );
}
