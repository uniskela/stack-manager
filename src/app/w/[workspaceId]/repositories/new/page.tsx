import type { Metadata } from 'next';
import Link from 'next/link';
import { getContainer } from '@/server/container';
import { ConnectRepositoryForm } from '@/ui/connect-repository-form';
import { Steps } from '@/ui/form';

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
    <div style={{ maxWidth: 640 }}>
      {onboarding ? <Steps current={3} /> : null}
      <div className="page-head">
        <div>
          <h1>Connect a repository</h1>
          <p className="muted">The Git repository that holds your Compose stacks, docs and configuration.</p>
        </div>
        {onboarding ? (
          <Link className="btn small" href={`/w/${workspaceId}`}>
            Skip for now
          </Link>
        ) : null}
      </div>
      <div className="card">
        <ConnectRepositoryForm workspaceId={workspaceId} providers={providers} credentials={credentials} />
      </div>
    </div>
  );
}
