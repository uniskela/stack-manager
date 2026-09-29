'use client';

import { ChevronsUpDown, FolderGit2, LogOut, Menu, Settings, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Brand } from '../brand';
import { Button } from '../primitives/button';

interface WorkspaceRef {
  id: string;
  name: string;
}

interface ShellProps {
  workspace: WorkspaceRef;
  workspaces: WorkspaceRef[];
  username: string;
}

/**
 * Signed-in layout. Wide screens get a persistent sidebar; narrow screens get a top bar whose menu button
 * opens the same navigation in a modal drawer (native <dialog>: focus trap, Escape and backdrop close).
 */
export function AppShell({ children, ...props }: ShellProps & { children: React.ReactNode }) {
  const pathname = usePathname();
  const drawerRef = useRef<HTMLDialogElement>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Navigating from inside the drawer closes it.
  useEffect(() => {
    drawerRef.current?.close();
  }, [pathname]);

  return (
    <div className="app-shell">
      <header className="mobile-bar">
        <Button
          variant="ghost"
          iconOnly
          aria-label="Open navigation"
          aria-expanded={drawerOpen}
          aria-controls="nav-drawer"
          onClick={() => {
            drawerRef.current?.showModal();
            setDrawerOpen(true);
          }}
          icon={<Menu className="icon" aria-hidden="true" />}
        />
        <Brand href={`/w/${props.workspace.id}`} />
        <span className="ws-crumb truncate">/ {props.workspace.name}</span>
      </header>

      <aside className="sidebar" aria-label="Sidebar">
        <SidebarContent {...props} pathname={pathname} />
      </aside>

      <dialog
        id="nav-drawer"
        ref={drawerRef}
        className="drawer"
        aria-label="Navigation"
        onClose={() => setDrawerOpen(false)}
        onClick={(e) => {
          // A click on the dialog element itself (not its content) is a click on the backdrop.
          if (e.target === e.currentTarget) e.currentTarget.close();
        }}
      >
        <SidebarContent {...props} pathname={pathname} onClose={() => drawerRef.current?.close()} />
      </dialog>

      {children}
    </div>
  );
}

function SidebarContent({
  workspace,
  workspaces,
  username,
  pathname,
  onClose,
}: ShellProps & { pathname: string; onClose?: () => void }) {
  const base = `/w/${workspace.id}`;
  const items = [
    {
      href: base,
      label: 'Repositories',
      Icon: FolderGit2,
      active: pathname === base || pathname.startsWith(`${base}/repositories`),
    },
    {
      href: `${base}/settings`,
      label: 'Settings',
      Icon: Settings,
      active: pathname.startsWith(`${base}/settings`),
    },
  ];

  return (
    <div className="sidebar-inner">
      <div className="sidebar-head">
        <Brand href={base} />
        {onClose ? (
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label="Close navigation"
            onClick={onClose}
            icon={<X className="icon" aria-hidden="true" />}
          />
        ) : null}
      </div>

      <WorkspaceSwitcher current={workspace} workspaces={workspaces} />

      <nav className="sidebar-nav" aria-label="Workspace">
        <ul>
          {items.map(({ href, label, Icon, active }) => (
            <li key={href}>
              <Link className="nav-link" href={href} aria-current={active ? 'page' : undefined}>
                <Icon className="icon" aria-hidden="true" />
                {label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <div className="sidebar-footer">
        <div className="account">
          <span className="avatar" aria-hidden="true">
            {username.slice(0, 1)}
          </span>
          <span className="truncate">
            <span className="visually-hidden">Signed in as </span>
            {username}
          </span>
        </div>
        <SignOutButton />
      </div>
    </div>
  );
}

function WorkspaceSwitcher({ current, workspaces }: { current: WorkspaceRef; workspaces: WorkspaceRef[] }) {
  const label = (
    <span className="grow">
      <span className="ws-label">Workspace</span>
      <span className="ws-name truncate">{current.name}</span>
    </span>
  );
  if (workspaces.length < 2) {
    return (
      <div className="ws-switcher">
        <div className="ws-current">{label}</div>
      </div>
    );
  }
  return (
    <details className="ws-switcher">
      <summary className="ws-current" aria-label={`Workspace: ${current.name}. Switch workspace`}>
        {label}
        <ChevronsUpDown className="icon muted" aria-hidden="true" />
      </summary>
      <ul className="ws-list">
        {workspaces.map((w) => (
          <li key={w.id}>
            <Link href={`/w/${w.id}`} aria-current={w.id === current.id ? 'page' : undefined}>
              <span className="truncate">{w.name}</span>
            </Link>
          </li>
        ))}
      </ul>
    </details>
  );
}

function SignOutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="ghost"
      loading={busy}
      icon={<LogOut className="icon" aria-hidden="true" />}
      onClick={async () => {
        setBusy(true);
        await api('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
        router.replace('/login');
        router.refresh();
      }}
    >
      Sign out
    </Button>
  );
}
