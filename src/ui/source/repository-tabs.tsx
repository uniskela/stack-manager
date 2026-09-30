'use client';

import { BookOpen, FileCode2, GitCompareArrows, LayoutList } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

/** Repository page sections: overview (stacks, sync, credential) and the whole-repository source views. */
export function RepositoryTabs({ base, drafts }: { base: string; drafts: number }) {
  const pathname = usePathname();
  const items = [
    { href: base, label: 'Overview', Icon: LayoutList, exact: true },
    { href: `${base}/files`, label: 'Files', Icon: FileCode2 },
    { href: `${base}/docs`, label: 'Docs', Icon: BookOpen },
    { href: `${base}/changes`, label: 'Changes', Icon: GitCompareArrows, count: drafts },
  ];
  return (
    <nav className="tabs" aria-label="Repository">
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
