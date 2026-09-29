import type { Metadata } from 'next';
import { getContainer } from '@/server/container';
import { joinRepoPath, normalizeRepoPath } from '@/shared/source/paths';
import { StackEditor } from '@/ui/source/stack-editor';

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
  const requested = (await searchParams).file;
  let path = stack.composePath;
  if (typeof requested === 'string' && requested) {
    try {
      const candidate = normalizeRepoPath(joinRepoPath(stack.rootPath, normalizeRepoPath(requested)));
      if (tree.entries.some((e) => e.path === candidate)) path = candidate;
    } catch {
      /* ignore a malformed ?file= and open the Compose file */
    }
  }
  const initialFile = await source
    .readFile(workspaceId, stack.repository.id, stack.rootPath, path)
    .catch(() => null);

  return (
    <StackEditor
      workspaceId={workspaceId}
      stackId={stackId}
      rootPath={stack.rootPath}
      composePath={stack.composePath}
      branch={stack.repository.defaultBranch}
      commitSha={tree.commitSha}
      entries={tree.entries}
      initialFile={initialFile}
    />
  );
}
