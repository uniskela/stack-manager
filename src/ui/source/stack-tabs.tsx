'use client';

import { BookOpen, Code2, GitCompareArrows, History, Settings2, Variable } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';

/** Stack page sections (docs/internal/UX.md). Deployments, runtime and secrets join in later phases. */
export function StackTabs({ base, drafts }: { base: string; drafts: number }) {
  const pathname = usePathname();
  const router = useRouter();
  const items = [
    { href: base, label: 'Editor', Icon: Code2, exact: true },
    { href: `${base}/docs`, label: 'Docs', Icon: BookOpen },
    { href: `${base}/environment`, label: 'Environment', Icon: Variable },
    { href: `${base}/changes`, label: 'Changes', Icon: GitCompareArrows, count: drafts },
    { href: `${base}/history`, label: 'History', Icon: History },
    { href: `${base}/settings`, label: 'Settings', Icon: Settings2 },
  ];

  // ponytail: chord only; full shortcut sheet / command palette stays on the UI plan.
  useEffect(() => {
    let pendingG = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable ||
          target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT')
      ) {
        pendingG = false;
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (pendingG && key === 'c') {
        e.preventDefault();
        pendingG = false;
        router.push(`${base}/changes`);
        return;
      }
      pendingG = key === 'g';
      clearTimeout(timer);
      if (pendingG) {
        timer = setTimeout(() => {
          pendingG = false;
        }, 1000);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      clearTimeout(timer);
    };
  }, [base, router]);

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
