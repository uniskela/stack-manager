import { getContainer } from '@/server/container';
import { AppShell } from '@/ui/shell/app-shell';
import { orNotFound, requireSession } from '../../_lib/session';

export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ workspaceId: string }>;
}) {
  const session = await requireSession();
  const { workspaceId } = await params;
  const { workspaces } = getContainer();
  const [workspace, all] = await Promise.all([orNotFound(workspaces.get(workspaceId)), workspaces.list()]);
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <AppShell
        workspace={{ id: workspace.id, name: workspace.name }}
        workspaces={all.map(({ id, name }) => ({ id, name }))}
        username={session.user.username}
      >
        <main id="main" className="main">
          {children}
        </main>
      </AppShell>
    </>
  );
}
