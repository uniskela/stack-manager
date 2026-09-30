import { Layers, Plus } from 'lucide-react';
import type { Metadata } from 'next';
import { getContainer } from '@/server/container';
import { ButtonLink } from '@/ui/primitives/button';
import { EmptyState } from '@/ui/primitives/empty-state';
import { PageHeader } from '@/ui/primitives/page-header';
import { OrganisedStacks } from '@/ui/stacks/organised-stacks';

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
  // Repository totals come from the repository itself: stack counts overlap (a root stack covers everything).
  const repositories = new Map(list.map((s) => [s.repository.id, s.repository]));
  const repoDrafts = new Map(
    await Promise.all(
      [...repositories.values()].map(
        async (r) => [r.id, r.headSha ? await source.countDrafts(r.id, '') : 0] as const,
      ),
    ),
  );

  const items = list.map((s, i) => ({
    id: s.id,
    name: s.name,
    rootPath: s.rootPath,
    draftCount: drafts[i] ?? 0,
    repository: {
      id: s.repository.id,
      name: s.repository.name,
      syncStatus: s.repository.syncStatus,
      fetched: s.repository.headSha !== null,
      draftCount: repoDrafts.get(s.repository.id) ?? 0,
    },
  }));

  return (
    <>
      <PageHeader
        title="Stacks"
        description="Compose stacks across your repositories. Open one to edit its source."
        actions={
          <ButtonLink
            href={`/w/${workspaceId}/repositories`}
            icon={<Plus className="icon" aria-hidden="true" />}
          >
            Add stacks
          </ButtonLink>
        }
      />
      <OrganisedStacks workspaceId={workspaceId} stacks={items} />
    </>
  );
}
