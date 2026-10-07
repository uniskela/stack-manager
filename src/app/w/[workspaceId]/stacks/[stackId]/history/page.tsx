import type { Metadata } from 'next';
import { getContainer } from '@/server/container';
import { HistoryView } from '@/ui/source/history-view';

export const metadata: Metadata = { title: 'History' };

export default async function StackHistoryPage({
  params,
}: {
  params: Promise<{ workspaceId: string; stackId: string }>;
}) {
  const { workspaceId, stackId } = await params;
  const { stacks } = getContainer();
  const stack = await stacks.get(workspaceId, stackId);
  return (
    <HistoryView apiBase={`/api/workspaces/${workspaceId}/stacks/${stackId}`} rootPath={stack.rootPath} />
  );
}
