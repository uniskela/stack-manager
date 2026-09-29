import Link from 'next/link';

/** Stacked-layers mark; `src/app/icon.svg` is the same drawing for the browser tab. */
export function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="8" fill="var(--accent)" />
      <g
        fill="none"
        stroke="var(--accent-contrast)"
        strokeWidth="2.2"
        strokeLinejoin="round"
        strokeLinecap="round"
      >
        <path d="M8.5 12 16 8l7.5 4-7.5 4z" fill="var(--accent-contrast)" />
        <path d="m8.5 16.5 7.5 4 7.5-4" />
        <path d="m8.5 20.5 7.5 4 7.5-4" />
      </g>
    </svg>
  );
}

export function Brand({ href = '/' }: { href?: string }) {
  return (
    <Link className="brand" href={href} aria-label="stack-manager home">
      <BrandMark />
      <span>stack-manager</span>
    </Link>
  );
}
