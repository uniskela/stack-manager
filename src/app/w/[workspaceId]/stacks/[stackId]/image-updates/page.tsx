import type { Metadata } from 'next';
import Link from 'next/link';
import { getContainer } from '@/server/container';
import { WudBindingForm } from '@/ui/image-updates/forms';
import { ImageUpdateTable } from '@/ui/image-updates/image-table';
import { ImageUpdatePlanner } from '@/ui/image-updates/planner';
import { Alert } from '@/ui/primitives/alert';
import { Section, SectionTitle } from '@/ui/primitives/section';

export const metadata: Metadata = { title: 'Stack image updates' };

export default async function StackImageUpdatesPage({
  params,
}: {
  params: Promise<{ workspaceId: string; stackId: string }>;
}) {
  const { workspaceId, stackId } = await params;
  const { imageUpdates } = getContainer();
  const view = await imageUpdates.stack(workspaceId, stackId);
  const { connected, binding, images, sourceStatus, stackName } = view;
  return (
    <div className="stack">
      {!connected ? (
        <Alert tone="info">
          <Link href={`/w/${workspaceId}/settings/wud`}>Connect WUD in Settings</Link> for automatic
          suggestions.
        </Alert>
      ) : null}
      <SectionTitle id="stack-images" title="Compose images" aside="From the fetched commit" />
      {images.length > 0 ? (
        <ImageUpdateTable labelledBy="stack-images" images={images} />
      ) : (
        <p className="muted">
          {sourceStatus === 'ready'
            ? 'No services defined in the primary Compose file.'
            : sourceStatus === 'invalid'
              ? 'Fix the committed Compose YAML to list service images.'
              : 'The primary Compose file is unavailable at the fetched commit.'}
        </p>
      )}
      {images.length > 0 ? (
        <Section id="plan-image-updates" title="Plan image updates">
          <ImageUpdatePlanner
            workspaceId={workspaceId}
            stacks={[{ id: stackId, name: stackName }]}
            known={[view]}
            initialStackId={stackId}
          />
        </Section>
      ) : null}
      {connected || binding ? (
        <div className="narrow">
          <Section id="wud-mapping" title="WUD mapping">
            <WudBindingForm workspaceId={workspaceId} stackId={stackId} binding={binding} />
          </Section>
        </div>
      ) : null}
    </div>
  );
}
