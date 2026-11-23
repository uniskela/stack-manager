import type { Metadata } from 'next';
import Link from 'next/link';
import { getContainer } from '@/server/container';
import { WudRefresh } from '@/ui/image-updates/forms';
import { ImageUpdateTable } from '@/ui/image-updates/image-table';
import { ImageUpdatePlanner } from '@/ui/image-updates/planner';
import { ButtonLink } from '@/ui/primitives/button';
import { PageHeader } from '@/ui/primitives/page-header';
import { Section, SectionTitle } from '@/ui/primitives/section';

export const metadata: Metadata = { title: 'Image updates' };

export default async function WorkspaceImageUpdatesPage({
  params,
}: Readonly<{
  params: Promise<{ workspaceId: string }>;
}>) {
  const { workspaceId } = await params;
  const { imageUpdates, stacks, config } = getContainer();
  const [{ connection, refreshing }, allStacks] = await Promise.all([
    imageUpdates.settings(workspaceId),
    stacks.list(workspaceId),
  ]);
  const { inventory, unboundCount } = connection
    ? await imageUpdates.queue(workspaceId)
    : { inventory: [], unboundCount: 0 };
  const base = `/w/${workspaceId}`;
  return (
    <div className="stack">
      <PageHeader
        title="Image updates"
        actions={
          <ButtonLink href={`${base}/settings/wud`}>{connection ? 'WUD settings' : 'Connect WUD'}</ButtonLink>
        }
      />
      {allStacks.length > 0 ? (
        <Section id="plan-image-updates" title="Plan image updates">
          <ImageUpdatePlanner
            workspaceId={workspaceId}
            stacks={allStacks.map(({ id, name }) => ({ id, name }))}
            known={inventory}
          />
        </Section>
      ) : (
        <p className="muted">
          <Link href={`${base}/stacks`}>Add a stack</Link> to plan image updates.
        </p>
      )}
      {connection ? (
        <>
          <WudRefresh
            workspaceId={workspaceId}
            connection={connection}
            refreshing={refreshing}
            workerEnabled={config.workerEnabled}
          />
          {unboundCount > 0 ? (
            <p className="muted">
              {unboundCount} {unboundCount === 1 ? 'stack needs' : 'stacks need'} a WUD mapping.{' '}
              <Link href={`${base}/stacks`}>View stacks</Link>
            </p>
          ) : null}
          {inventory.map((stack) => (
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
      ) : null}
    </div>
  );
}
