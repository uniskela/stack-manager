import type { Metadata } from 'next';
import { relativeTo } from '@/shared/source/paths';
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
          composePath={relativeTo(stack.rootPath, stack.composePath)}
          settings={settings}
          attempts={history.attempts}
          decisions={history.decisions}
          workerEnabled={config.workerEnabled}
        />
      </Section>
    </div>
  );
}
