import type { Metadata } from 'next';
import { getContainer } from '@/server/container';
import { WudConnectionForm, WudRefresh } from '@/ui/image-updates/forms';
import { Section } from '@/ui/primitives/section';

export const metadata: Metadata = { title: 'WUD settings' };

export default async function WudSettingsPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const { imageUpdates, config } = getContainer();
  const { connection, refreshing } = await imageUpdates.settings(workspaceId);
  return (
    <div className="narrow stack">
      <Section
        id="wud-connection"
        title="WUD connection"
        description="Read image update findings from What’s Up Docker."
      >
        <WudConnectionForm workspaceId={workspaceId} connection={connection} />
      </Section>
      {connection ? (
        <Section id="wud-refresh" title="Refresh status">
          <WudRefresh
            workspaceId={workspaceId}
            connection={connection}
            refreshing={refreshing}
            workerEnabled={config.workerEnabled}
          />
        </Section>
      ) : null}
    </div>
  );
}
