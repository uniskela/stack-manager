import { Folder, FolderGit2, GitBranch, GitCommitHorizontal, Hourglass } from 'lucide-react';
import Link from 'next/link';
import { getContainer } from '@/server/container';
import { EmptyState } from '@/ui/primitives/empty-state';
import { PageHeader } from '@/ui/primitives/page-header';
import { StackTabs } from '@/ui/source/stack-tabs';
import { StackBreadcrumbs } from '@/ui/stacks/stack-breadcrumbs';
import { StackSwitcher } from '@/ui/stacks/stack-switcher';
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
  const [drafts, siblings] = await Promise.all([
    fetched ? source.countDrafts(stack.repository.id, stack.rootPath) : 0,
    stacks.listForRepository(workspaceId, stack.repository.id),
  ]);
  const base = `/w/${workspaceId}/stacks/${stackId}`;

  return (
    <div className="wide-page">
      <div className="stack-head">
        <PageHeader
          breadcrumbs={
            <StackBreadcrumbs
              workspaceId={workspaceId}
              repository={{ id: stack.repository.id, name: stack.repository.name }}
              stackName={stack.name}
            />
          }
          title={stack.name}
          actions={
            <StackSwitcher
              workspaceId={workspaceId}
              currentId={stack.id}
              repository={{ id: stack.repository.id, name: stack.repository.name }}
              stacks={siblings.map((s) => ({ id: s.id, name: s.name, rootPath: s.rootPath }))}
            />
          }
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
