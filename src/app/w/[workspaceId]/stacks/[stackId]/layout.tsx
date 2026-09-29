import { Folder, FolderGit2, GitBranch, GitCommitHorizontal, Hourglass } from 'lucide-react';
import Link from 'next/link';
import { getContainer } from '@/server/container';
import { Breadcrumbs } from '@/ui/primitives/breadcrumbs';
import { EmptyState } from '@/ui/primitives/empty-state';
import { PageHeader } from '@/ui/primitives/page-header';
import { StackTabs } from '@/ui/source/stack-tabs';
import { orNotFound } from '../../../../_lib/session';

export default async function StackLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ workspaceId: string; stackId: string }>;
}) {
  const { workspaceId, stackId } = await params;
  const { stacks, source } = getContainer();
  const stack = await orNotFound(stacks.get(workspaceId, stackId));
  const fetched = stack.repository.headSha !== null;
  const drafts = fetched ? await source.countDrafts(stack.repository.id, stack.rootPath) : 0;
  const base = `/w/${workspaceId}/stacks/${stackId}`;

  return (
    <div className="wide-page">
      <div className="stack-head">
        <PageHeader
          breadcrumbs={
            <Breadcrumbs
              items={[{ label: 'Stacks', href: `/w/${workspaceId}/stacks` }, { label: stack.name }]}
            />
          }
          title={stack.name}
          description={
            <div className="stack-meta">
              <span>
                <FolderGit2 className="icon" aria-hidden="true" />
                <Link href={`/w/${workspaceId}/repositories/${stack.repository.id}`}>
                  {stack.repository.name}
                </Link>
              </span>
              <span>
                <GitBranch className="icon" aria-hidden="true" />
                <span className="mono">{stack.repository.defaultBranch}</span>
              </span>
              <span>
                <Folder className="icon" aria-hidden="true" />
                <span className="mono">{stack.rootPath || '(repository root)'}</span>
              </span>
              {stack.repository.headSha ? (
                <span title={stack.repository.headSha}>
                  <GitCommitHorizontal className="icon" aria-hidden="true" />
                  <span className="mono">{stack.repository.headSha.slice(0, 7)}</span>
                </span>
              ) : null}
            </div>
          }
        />
        <StackTabs base={base} drafts={drafts} />
      </div>
      {fetched ? (
        children
      ) : (
        <EmptyState icon={Hourglass} title="Waiting for the first fetch">
          The repository has not been fetched yet. Open the repository and choose Fetch now.
        </EmptyState>
      )}
    </div>
  );
}
