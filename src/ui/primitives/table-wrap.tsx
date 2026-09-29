import type { ReactNode } from 'react';

/**
 * Horizontal scroll container for tables. It is a labelled, focusable region so keyboard users can
 * scroll wide tables on narrow screens (WCAG 2.1.1; axe `scrollable-region-focusable`).
 */
export function TableWrap({ labelledBy, children }: { labelledBy: string; children: ReactNode }) {
  return (
    <div className="table-wrap card flush" tabIndex={0} role="region" aria-labelledby={labelledBy}>
      {children}
    </div>
  );
}
