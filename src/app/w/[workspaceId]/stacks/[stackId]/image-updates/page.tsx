import type { Metadata } from 'next';
import Link from 'next/link';
import { getContainer } from '@/server/container';
import { ImageUpdateTable } from '@/ui/image-updates/image-table';
import { ImageUpdatePlanner } from '@/ui/image-updates/planner';
import { StackWudMatch } from '@/ui/image-updates/stack-match';
import { Alert } from '@/ui/primitives/alert';
import { Section, SectionTitle } from '@/ui/primitives/section';

export const metadata: Metadata = { title: 'Stack image updates' };

const emptySourceMessages = {
  ready: 'No services defined in the primary Compose file.',
  invalid: 'Fix the committed Compose YAML to list service images.',
  unavailable: 'The primary Compose file is unavailable at the fetched commit.',
};

export default async function StackImageUpdatesPage({
  params,
}: Readonly<{
  params: Promise<{ workspaceId: string; stackId: string }>;
}>) {
  const { workspaceId, stackId } = await params;
  const { imageUpdates, imageUpdateStaging } = getContainer();
  const [view, repositoryWorkflow] = await Promise.all([
    imageUpdates.stack(workspaceId, stackId),
    imageUpdateStaging.usesRepositoryWorkflow(workspaceId, stackId).catch(() => false),
  ]);
  const { connected, binding, images, sourceStatus, stackName } = view;
  const setup = `/w/${workspaceId}/stacks/${stackId}/image-updates/setup`;
  return (
    <div className="stack">
      {!connected ? (
        <Alert tone="info">
          <Link href={setup}>Connect WUD</Link> for automatic update suggestions from What’s Up Docker. You
          can also enter a tag yourself below.
        </Alert>
      ) : null}
      <SectionTitle
        id="stack-images"
        title="Images in Compose"
        aside={
          <>
            From the latest Git fetch · <Link href={setup}>Image update setup guide</Link>
          </>
        }
      />
      {images.length > 0 ? (
        <ImageUpdateTable labelledBy="stack-images" images={images} connected={connected} />
      ) : (
        <p className="muted">{emptySourceMessages[sourceStatus]}</p>
      )}
      {connected || binding ? (
        <Section id="wud-mapping" title="Match this stack to WUD">
          <StackWudMatch workspaceId={workspaceId} stackId={stackId} binding={binding} />
        </Section>
      ) : null}
      {images.length > 0 ? (
        <Section id="plan-image-updates" title="Plan image updates">
          <ImageUpdatePlanner
            workspaceId={workspaceId}
            stacks={[{ id: stackId, name: stackName }]}
            known={[view]}
            initialStackId={stackId}
            repositoryWorkflow={repositoryWorkflow}
          />
        </Section>
      ) : null}
    </div>
  );
}
