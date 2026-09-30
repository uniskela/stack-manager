import { ChevronRight, Layers } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { getContainer } from '@/server/container';
import { ButtonLink } from '@/ui/primitives/button';
import { EmptyState } from '@/ui/primitives/empty-state';
import { PageHeader } from '@/ui/primitives/page-header';

export const metadata: Metadata = { title: 'Stacks' };

export default async function StacksPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const { stacks, source } = getContainer();
  const list = await stacks.list(workspaceId);

  if (list.length === 0) {
    return (
      <EmptyState
        icon={Layers}
        headingLevel={1}
        title="No stacks yet"
        actions={<ButtonLink href={`/w/${workspaceId}/repositories`}>Go to repositories</ButtonLink>}
      >
        A stack is a folder in one of your repositories with a Compose file. Open a repository to pick the
        folders stack-manager found, or add one by path.
      </EmptyState>
    );
  }

  const drafts = await Promise.all(
    list.map((s) =>
      s.repository.headSha ? source.countDrafts(s.repository.id, s.rootPath) : Promise.resolve(0),
    ),
  );

  return (
    <>
      <PageHeader
        title="Stacks"
        description="Compose stacks defined in your repositories. Open one to edit its source."
      />
      <ul className="list">
        {list.map((s, i) => (
          <li key={s.id}>
            <Link className="list-row" href={`/w/${workspaceId}/stacks/${s.id}`}>
              <Layers className="icon muted" aria-hidden="true" />
              <div className="grow">
                <div className="title truncate">{s.name}</div>
                <div className="muted truncate list-row-sub">
                  {s.repository.name} · <span className="mono">{s.rootPath || '(root)'}</span>
                </div>
              </div>
              {drafts[i] ? (
                <span className="pill pending">
                  {drafts[i]} draft{drafts[i] === 1 ? '' : 's'}
                </span>
              ) : null}
              <ChevronRight className="icon muted" aria-hidden="true" />
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
