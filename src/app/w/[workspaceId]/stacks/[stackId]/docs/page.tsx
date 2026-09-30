import type { Metadata } from 'next';
import { getContainer } from '@/server/container';
import { relativeTo } from '@/shared/source/paths';
import { DocWorkspace } from '@/ui/source/doc-workspace';
import { markdownDocs, resolveRequested } from '../../../../../_lib/source';

export const metadata: Metadata = { title: 'Docs' };

export default async function StackDocsPage({
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
  const docs = markdownDocs(tree.entries, stack.rootPath);
  const path =
    resolveRequested(stack.rootPath, (await searchParams).doc, (p) => docs.some((d) => d.path === p)) ??
    docs[0]?.path ??
    null;
  const file = path
    ? await source.readFile(workspaceId, stack.repository.id, stack.rootPath, path).catch(() => null)
    : null;
  const base = `/w/${workspaceId}/stacks/${stackId}/docs`;
  const hrefFor = Object.fromEntries(
    docs.map((d) => [d.path, `${base}?doc=${encodeURIComponent(relativeTo(stack.rootPath, d.path))}`]),
  );

  return (
    <DocWorkspace
      key={path ?? 'none'}
      workspaceId={workspaceId}
      apiBase={`/api/workspaces/${workspaceId}/stacks/${stackId}`}
      rootPath={stack.rootPath}
      docs={docs.map((d) => ({ path: d.path, draft: d.draft !== null }))}
      file={file}
      hrefFor={hrefFor}
      editorHref={`/w/${workspaceId}/stacks/${stackId}`}
      docsHref={base}
    />
  );
}

