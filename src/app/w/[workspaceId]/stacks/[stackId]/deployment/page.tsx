import type { Metadata } from 'next';
import { getContainer } from '@/server/container';
import { DeploymentSettings } from '@/ui/deployment-settings';
import { Section } from '@/ui/primitives/section';

export const metadata: Metadata = { title: 'Stack deployment' };
export default async function DeploymentPage({
  params,
}: Readonly<{
  params: Promise<{ workspaceId: string; stackId: string }>;
}>) {
  const { workspaceId, stackId } = await params;
  const { stacks, deployments, config } = getContainer();
  const [stack, settings, history] = await Promise.all([
    stacks.get(workspaceId, stackId),
    deployments.settings(workspaceId, stackId),
    deployments.history(workspaceId, stackId),
  ]);
  return (
    <div className="narrow stack">
      <Section id="deployment" title="Deployment">
        <DeploymentSettings
          workspaceId={workspaceId}
          stackId={stackId}
          stackName={stack.name}
          settings={settings}
          attempts={history.attempts}
          workerEnabled={config.workerEnabled}
        />
      </Section>
    </div>
  );
}
