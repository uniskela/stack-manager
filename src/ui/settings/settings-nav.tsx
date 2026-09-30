'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export function SettingsNav({ base }: { base: string }) {
  const pathname = usePathname();
  const tabs = [
    { href: base, label: 'General', match: (p: string) => p === base },
    {
      href: `${base}/credentials`,
      label: 'Credentials',
      match: (p: string) => p.startsWith(`${base}/credentials`),
    },
    {
      href: `${base}/activity`,
      label: 'Activity',
      match: (p: string) => p.startsWith(`${base}/activity`),
    },
    {
      href: `${base}/account`,
      label: 'Account',
      match: (p: string) => p.startsWith(`${base}/account`),
    },
  ];

  return (
    <nav className="tabs" aria-label="Settings">
      {tabs.map(({ href, label, match }) => {
        const active = match(pathname);
        return (
          <Link key={href} href={href} aria-current={active ? 'page' : undefined}>
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
