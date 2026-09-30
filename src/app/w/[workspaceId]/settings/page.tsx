import { getContainer } from '@/server/container';
import { Section } from '@/ui/primitives/section';
import { RenameWorkspaceForm } from '@/ui/workspace-form';

export default async function SettingsGeneralPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const workspace = await getContainer().workspaces.get(workspaceId);

  return (
    <Section id="ws-general" title="Workspace">
      <RenameWorkspaceForm workspaceId={workspace.id} initialName={workspace.name} />
    </Section>
  );
}
