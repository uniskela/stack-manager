'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from './api';

export function WorkspaceNav({ workspaceId }: { workspaceId: string }) {
  const pathname = usePathname();
  const base = `/w/${workspaceId}`;
  const items = [
    {
      href: base,
      label: 'Repositories',
      active: pathname === base || pathname.startsWith(`${base}/repositories`),
    },
    { href: `${base}/settings`, label: 'Settings', active: pathname.startsWith(`${base}/settings`) },
  ];
  return (
    <nav className="nav" aria-label="Workspace">
      {items.map((item) => (
        <Link key={item.href} href={item.href} aria-current={item.active ? 'page' : undefined}>
          {item.label}
        </Link>
      ))}
      <LogoutButton />
    </nav>
  );
}

function LogoutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="linklike"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await api('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
        router.replace('/login');
        router.refresh();
      }}
    >
      Sign out
    </button>
  );
}
