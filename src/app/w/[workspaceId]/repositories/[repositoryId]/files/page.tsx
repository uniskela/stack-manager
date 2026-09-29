import type { Metadata } from 'next';
import { getContainer } from '@/server/container';
import { basename, isComposeFileName, isEnvTemplateName } from '@/shared/source/paths';
import { StackEditor } from '@/ui/source/stack-editor';
import { NotFetched, repositorySourceApi } from '../../../../../_lib/repository-source';
import { markdownDocs, resolveRequested } from '../../../../../_lib/source';

export const metadata: Metadata = { title: 'Files' };

/**
 * The whole repository in the editor, for files outside any stack: the root README, a docs/ folder,
 * shared .env.example templates. Same drafts and secret-file rules as the stack editor.
 */
export default async function RepositoryFilesPage({
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
  const files = tree.entries.filter((e) => e.kind === 'file' && !e.locked);

  // Open ?file= if given, else a sensible landing file: README, a root .env template, a root Compose file.
  const rootFile = (match: (name: string) => boolean) =>
    files.find((e) => !e.path.includes('/') && match(basename(e.path)))?.path;
  const path =
    resolveRequested('', (await searchParams).file, (p) => tree.entries.some((e) => e.path === p)) ??
    markdownDocs(files, '').find((e) => !e.path.includes('/'))?.path ??
    rootFile(isEnvTemplateName) ??
    rootFile(isComposeFileName) ??
    null;
  const initialFile = path
    ? await source.readFile(workspaceId, repositoryId, '', path).catch(() => null)
    : null;

  return (
    <div className="wide-page">
      <StackEditor
        workspaceId={workspaceId}
        apiBase={repositorySourceApi(workspaceId, repositoryId)}
        rootPath=""
        branch={repo.defaultBranch}
        commitSha={tree.commitSha}
        entries={tree.entries}
        initialFile={initialFile}
      />
    </div>
  );
}
