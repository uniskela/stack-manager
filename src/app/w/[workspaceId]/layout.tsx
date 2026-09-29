import { getContainer } from '@/server/container';
import { Brand } from '@/ui/brand';
import { WorkspaceNav } from '@/ui/nav';
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
  const workspace = await orNotFound(getContainer().workspaces.get(workspaceId));
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <Brand href={`/w/${workspace.id}`} />
        <span className="crumb" title={`Signed in as ${session.user.username}`}>
          / {workspace.name}
        </span>
        <WorkspaceNav workspaceId={workspace.id} />
      </header>
      <main id="main" className="main">
        {children}
      </main>
    </>
  );
}
