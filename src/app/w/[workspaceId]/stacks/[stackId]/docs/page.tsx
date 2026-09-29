import type { Metadata } from 'next';
import { getContainer } from '@/server/container';
import { isMarkdownPath, joinRepoPath, normalizeRepoPath, relativeTo } from '@/shared/source/paths';
import { DocWorkspace } from '@/ui/source/doc-workspace';

export const metadata: Metadata = { title: 'Docs' };

/** README first, then top-level pages, then nested ones. */
function docOrder(root: string) {
  const weight = (p: string) => {
    const rel = relativeTo(root, p);
    if (/^readme\.md$/i.test(rel)) return 0;
    return rel.includes('/') ? 2 : 1;
  };
  return (a: string, b: string) => weight(a) - weight(b) || a.localeCompare(b);
}

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
  const docs = tree.entries
    .filter((e) => e.kind === 'file' && !e.locked && isMarkdownPath(e.path))
    .sort((a, b) => docOrder(stack.rootPath)(a.path, b.path));

  const requested = (await searchParams).doc;
  let path = docs[0]?.path ?? null;
  if (typeof requested === 'string' && requested) {
    try {
      const candidate = normalizeRepoPath(joinRepoPath(stack.rootPath, normalizeRepoPath(requested)));
      if (docs.some((d) => d.path === candidate)) path = candidate;
    } catch {
      /* ignore malformed ?doc= */
    }
  }
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
      stackId={stackId}
      rootPath={stack.rootPath}
      docs={docs.map((d) => ({ path: d.path, draft: d.draft !== null }))}
      file={file}
      hrefFor={hrefFor}
      editorHref={`/w/${workspaceId}/stacks/${stackId}`}
      docsHref={base}
    />
  );
}

