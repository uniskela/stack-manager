'use client';

import { useEffect, useState } from 'react';

/** Renders a timestamp in the viewer's locale/time zone (server renders the ISO value first). */
export function LocalTime({ iso, fallback = 'Never' }: { iso: string | null; fallback?: string }) {
  const [text, setText] = useState(iso ?? fallback);
  useEffect(() => {
    if (!iso) return;
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
    let label: string;
    if (diff < 60_000) label = 'just now';
    else if (diff < 3_600_000) label = rtf.format(-Math.round(diff / 60_000), 'minute');
    else if (diff < 86_400_000) label = rtf.format(-Math.round(diff / 3_600_000), 'hour');
    else label = d.toLocaleString();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- locale formatting must happen client-side
    setText(label);
  }, [iso]);
  if (!iso) return <span className="muted">{fallback}</span>;
  return (
    <time dateTime={iso} title={iso} suppressHydrationWarning>
      {text}
    </time>
  );
}
