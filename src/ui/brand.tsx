import Link from 'next/link';

/**
 * Folded-ribbon "S": one strip of signal-yellow paper folded twice, the darker triangles are its underside.
 * `src/app/icon.svg` and `docs/assets/logo.svg` are the same drawing with fixed colours.
 */
export function BrandMark({ className = 'brand-mark' }: Readonly<{ className?: string }>) {
  return (
    <svg className={className} viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      <rect width="100" height="100" rx="22" fill="var(--ink)" />
      <path fill="var(--signal-fold)" d="M21 31h7l11 12H11zM79 69h-7L61 57h28z" />
      <path
        fill="var(--signal)"
        d="M24 13h53l12 12v6H21L11 43V26zM11 43h66l12 14H23zM76 87H23L11 75v-6h68l10-12v17z"
      />
    </svg>
  );
}

export function Brand({ href = '/' }: Readonly<{ href?: string }>) {
  return (
    <Link className="brand" href={href} aria-label="stack-manager home">
      <BrandMark />
      <span className="brand-word">stack-manager</span>
    </Link>
  );
}
