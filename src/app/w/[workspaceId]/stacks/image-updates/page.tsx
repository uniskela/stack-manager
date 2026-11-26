import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import type { ImageUpdateService } from '@/server/application/image-update-service';
import { getContainer } from '@/server/container';
import { WudRefresh } from '@/ui/image-updates/forms';
import { ImageUpdateTable } from '@/ui/image-updates/image-table';
import { WudMappingDiscovery } from '@/ui/image-updates/mapping-discovery';
import { ImageUpdatePlanner } from '@/ui/image-updates/planner';
import { ImageUpdatePullRequests } from '@/ui/image-updates/pull-requests';
import { ButtonLink } from '@/ui/primitives/button';
import { PageHeader } from '@/ui/primitives/page-header';
import { Section, SectionTitle } from '@/ui/primitives/section';

export const metadata: Metadata = { title: 'Image updates' };

export default async function WorkspaceImageUpdatesPage({
  params,
  searchParams,
}: Readonly<{
  searchParams: Promise<{ view?: string }>;
  params: Promise<{ workspaceId: string }>;
}>) {
  const { workspaceId } = await params;
  const { imageUpdates, config } = getContainer();
  const [{ connection, refreshing }, { inventory, allStacks, needsSetup, unboundCount }] = await Promise.all([
    imageUpdates.settings(workspaceId),
    imageUpdates.queue(workspaceId),
  ]);
  const base = `/w/${workspaceId}`;
  const selected = (await searchParams).view;
  const view = selected === 'all' || selected === 'setup' ? selected : 'available';
  const queuePath = `${base}/stacks/image-updates`;
  const available = inventory
    .map((stack) => ({ ...stack, images: stack.images.filter((image) => image.status === 'available') }))
    .filter((stack) => stack.images.length);
  const tabs = [
    {
      value: 'available',
      label: 'Updates available',
      count: available.reduce((sum, stack) => sum + stack.images.length, 0),
    },
    { value: 'setup', label: 'Stacks needing setup', count: needsSetup.length },
    {
      value: 'all',
      label: 'All linked images',
      count: inventory.reduce((sum, stack) => sum + stack.images.length, 0),
    },
  ];
  return (
    <div className="stack">
      <PageHeader
        title="Image updates"
        actions={
          <ButtonLink href={`${base}/settings/wud`}>{connection ? 'WUD settings' : 'Connect WUD'}</ButtonLink>
        }
      />
      {connection ? (
        <WudRefresh
          workspaceId={workspaceId}
          connection={connection}
          refreshing={refreshing}
          workerEnabled={config.workerEnabled}
        />
      ) : (
        <p className="muted">Connect What’s Up Docker to see suggested image tags for this workspace.</p>
      )}
      <nav className="actions" aria-label="Image update filters">
        {tabs.map((tab) => (
          <ButtonLink
            key={tab.value}
            href={tab.value === 'available' ? queuePath : `${queuePath}?view=${tab.value}`}
            aria-current={tab.value === view ? 'page' : undefined}
            variant={tab.value === view ? 'primary' : 'secondary'}
          >
            {tab.label} ({tab.count})
          </ButtonLink>
        ))}
      </nav>
      <Suspense fallback={null}>
        <OpenImageUpdatePullRequests workspaceId={workspaceId} />
      </Suspense>
      {view === 'setup' ? (
        <WudSetupList
          workspaceId={workspaceId}
          stacks={needsSetup}
          hasStacks={allStacks.length > 0}
          connected={Boolean(connection)}
          unboundCount={unboundCount}
        />
      ) : (
        <>
          {view === 'available' && connection && !available.length ? (
            <p>No newer tags reported for linked stacks.</p>
          ) : null}
          {allStacks.length > 0 ? (
            <Section id="plan-image-updates" title="Plan image updates">
              <ImageUpdatePlanner workspaceId={workspaceId} stacks={allStacks} known={inventory} />
            </Section>
          ) : (
            <p className="muted">
              <Link href={`${base}/stacks`}>Add a stack</Link> to plan image updates.
            </p>
          )}
          {(view === 'all' ? inventory : available).map((stack) => (
            <section key={stack.stackId} className="stack" aria-labelledby={`images-${stack.stackId}`}>
              <SectionTitle
                id={`images-${stack.stackId}`}
                title={<Link href={`${base}/stacks/${stack.stackId}/image-updates`}>{stack.stackName}</Link>}
              />
              {stack.images.length ? (
                <ImageUpdateTable labelledBy={`images-${stack.stackId}`} images={stack.images} />
              ) : (
                <p className="muted">Open the stack to check its Compose source and mapping.</p>
              )}
            </section>
          ))}
        </>
      )}
    </div>
  );
}

function WudSetupList({
  workspaceId,
  stacks,
  hasStacks,
  connected,
  unboundCount,
}: Readonly<{
  workspaceId: string;
  stacks: Awaited<ReturnType<ImageUpdateService['queue']>>['needsSetup'];
  hasStacks: boolean;
  connected: boolean;
  unboundCount: number;
}>) {
  const setupLabel = connected ? 'Match WUD project' : 'Set up WUD';
  const emptyMessage = hasStacks ? 'All stacks are linked to WUD.' : 'Add a stack to match it to WUD.';
  return (
    <Section id="wud-matches" title="Match stacks to WUD">
      {stacks.length > 0 ? (
        <ul className="list">
          {stacks.map((stack) => (
            <li key={stack.id}>
              <Link className="list-row" href={`/w/${workspaceId}/stacks/${stack.id}/image-updates/setup`}>
                <strong className="grow">{stack.name}</strong>
                <span>
                  {stack.unmatched.length ? `Missing from WUD: ${stack.unmatched.join(', ')}` : setupLabel}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p>{emptyMessage}</p>
      )}
      {connected && unboundCount > 0 ? (
        <WudMappingDiscovery workspaceId={workspaceId} labelledBy="wud-matches" />
      ) : null}
    </Section>
  );
}

async function OpenImageUpdatePullRequests({ workspaceId }: Readonly<{ workspaceId: string }>) {
  const { wudImageUpdateReview } = getContainer();
  const queue = await wudImageUpdateReview.list(workspaceId);
  if (!queue.pulls.length && !queue.unreadableRepositories) return null;
  return <ImageUpdatePullRequests workspaceId={workspaceId} queue={queue} />;
}
