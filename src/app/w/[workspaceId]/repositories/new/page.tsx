import type { Metadata } from 'next';
import { getContainer } from '@/server/container';
import { ConnectRepositoryForm } from '@/ui/connect-repository-form';
import { Steps } from '@/ui/form';
import { Breadcrumbs } from '@/ui/primitives/breadcrumbs';
import { ButtonLink } from '@/ui/primitives/button';
import { PageHeader } from '@/ui/primitives/page-header';

export const metadata: Metadata = { title: 'Connect repository' };

export default async function NewRepositoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[]>>;
}) {
  const { workspaceId } = await params;
  const onboarding = (await searchParams).onboarding === '1';
  const container = getContainer();
  const providers = container.gitProviders
    .descriptors()
    .map(({ type, displayName, exampleUrl, tokenHelp }) => ({
      type,
      displayName,
      exampleUrl,
      tokenHelp,
    }));
  const credentials = (await container.credentials.list(workspaceId))
    .filter((c) => c.kind === 'git')
    .map(({ id, label, hint, providerType }) => ({ id, label, hint, providerType }));

  return (
    <div className="narrow">
      {onboarding ? <Steps current={3} /> : null}
      <PageHeader
        breadcrumbs={
          onboarding ? undefined : (
            <Breadcrumbs
              items={[
                { label: 'Repositories', href: `/w/${workspaceId}/repositories` },
                { label: 'Connect' },
              ]}
            />
          )
        }
        title="Connect a repository"
        description="The Git repository that holds your Compose stacks, docs and configuration."
        actions={
          onboarding ? (
            <ButtonLink size="sm" href={`/w/${workspaceId}/repositories`}>
              Skip for now
            </ButtonLink>
          ) : undefined
        }
      />
      <div className="card">
        <ConnectRepositoryForm workspaceId={workspaceId} providers={providers} credentials={credentials} />
      </div>
    </div>
  );
}
