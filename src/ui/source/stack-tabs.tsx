'use client';

import { BookOpen, Code2, GitCompareArrows, Settings2, Variable } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

/** Stack page sections (docs/UX.md). Deployments, runtime and secrets join in later phases. */
export function StackTabs({ base, drafts }: { base: string; drafts: number }) {
  const pathname = usePathname();
  const items = [
    { href: base, label: 'Editor', Icon: Code2, exact: true },
    { href: `${base}/docs`, label: 'Docs', Icon: BookOpen },
    { href: `${base}/environment`, label: 'Environment', Icon: Variable },
    { href: `${base}/changes`, label: 'Changes', Icon: GitCompareArrows, count: drafts },
    { href: `${base}/settings`, label: 'Settings', Icon: Settings2 },
  ];
  return (
    <nav className="tabs" aria-label="Stack">
      {items.map(({ href, label, Icon, exact, count }) => {
        const active = exact ? pathname === href : pathname.startsWith(href);
        return (
          <Link key={href} href={href} aria-current={active ? 'page' : undefined}>
            <Icon className="icon" aria-hidden="true" />
            {label}
            {count ? (
              <span className="count">
                {count}
                <span className="visually-hidden"> drafts</span>
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
