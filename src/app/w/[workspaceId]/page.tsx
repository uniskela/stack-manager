import { FolderGit2 } from 'lucide-react';
import type { Metadata } from 'next';
import { getContainer } from '@/server/container';
import { ButtonLink } from '@/ui/primitives/button';
import { EmptyState } from '@/ui/primitives/empty-state';
import { PageHeader } from '@/ui/primitives/page-header';

export const metadata: Metadata = { title: 'Dashboard' };

export default async function DashboardPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const container = getContainer();
  const [workspace, repositories] = await Promise.all([
    container.workspaces.get(workspaceId),
    container.repositories.list(workspaceId),
  ]);
  const connectHref = `/w/${workspaceId}/repositories/new`;

  if (repositories.length === 0) {
    return (
      <EmptyState
        icon={FolderGit2}
        headingLevel={1}
        title="Connect your Compose repository"
        actions={
          <ButtonLink variant="primary" href={connectHref}>
            Connect repository
          </ButtonLink>
        }
      >
        stack-manager works from the Git repository that describes your stacks. Connect it over HTTPS; a
        read-only token is enough to start.
      </EmptyState>
    );
  }

  return <PageHeader title={workspace.name} description="Source workspace overview" />;
}
