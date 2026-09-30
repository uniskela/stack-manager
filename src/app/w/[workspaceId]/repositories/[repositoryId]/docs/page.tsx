import type { Metadata } from 'next';
import { getContainer } from '@/server/container';
import { DocWorkspace } from '@/ui/source/doc-workspace';
import { NotFetched, repositorySourceApi } from '../../../../../_lib/repository-source';
import { markdownDocs, resolveRequested } from '../../../../../_lib/source';

export const metadata: Metadata = { title: 'Docs' };

/** Every Markdown file in the repository (root docs and each stack's), rendered and editable as drafts. */
export default async function RepositoryDocsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string; repositoryId: string }>;
  searchParams: Promise<Record<string, string | string[]>>;
}) {
  const { workspaceId, repositoryId } = await params;
  const { repositories, source } = getContainer();
  const repo = await repositories.get(workspaceId, repositoryId);
  if (!repo.headSha) return <NotFetched />;
  const tree = await source.tree(workspaceId, repositoryId, '');
  const docs = markdownDocs(tree.entries, '');
  const path =
    resolveRequested('', (await searchParams).doc, (p) => docs.some((d) => d.path === p)) ?? docs[0]?.path ?? null;
  const file = path ? await source.readFile(workspaceId, repositoryId, '', path).catch(() => null) : null;
  const base = `/w/${workspaceId}/repositories/${repositoryId}`;
  const hrefFor = Object.fromEntries(docs.map((d) => [d.path, `${base}/docs?doc=${encodeURIComponent(d.path)}`]));

  return (
    <div className="wide-page">
      <DocWorkspace
        key={path ?? 'none'}
        workspaceId={workspaceId}
        apiBase={repositorySourceApi(workspaceId, repositoryId)}
        rootPath=""
        docs={docs.map((d) => ({ path: d.path, draft: d.draft !== null }))}
        file={file}
        hrefFor={hrefFor}
        editorHref={`${base}/files`}
        docsHref={`${base}/docs`}
      />
    </div>
  );
}
