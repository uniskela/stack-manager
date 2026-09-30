import type { Metadata } from 'next';
import { getContainer } from '@/server/container';
import { StackEditor } from '@/ui/source/stack-editor';
import { resolveRequested } from '../../../../_lib/source';

export const metadata: Metadata = { title: 'Editor' };

export default async function StackEditorPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string; stackId: string }>;
  searchParams: Promise<Record<string, string | string[]>>;
}) {
  const { workspaceId, stackId } = await params;
  const { stacks, source } = getContainer();
  const stack = await stacks.get(workspaceId, stackId);
  const tree = await source.tree(workspaceId, stack.repository.id, stack.rootPath);

  // ?file= is relative to the stack folder; fall back to the Compose file.
  const path =
    resolveRequested(stack.rootPath, (await searchParams).file, (p) =>
      tree.entries.some((e) => e.path === p),
    ) ?? stack.composePath;
  const initialFile = await source
    .readFile(workspaceId, stack.repository.id, stack.rootPath, path)
    .catch(() => null);

  return (
    <StackEditor
      workspaceId={workspaceId}
      apiBase={`/api/workspaces/${workspaceId}/stacks/${stackId}`}
      rootPath={stack.rootPath}
      composePaths={[stack.composePath]}
      branch={stack.repository.defaultBranch}
      commitSha={tree.commitSha}
      entries={tree.entries}
      initialFile={initialFile}
    />
  );
}
