import { LoaderCircle } from 'lucide-react';
import Link from 'next/link';
import type { ComponentProps, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
export type ButtonSize = 'md' | 'sm';

interface ButtonStyleProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Leading icon (decorative; the label carries the meaning). */
  icon?: ReactNode;
  /** Icon-only buttons must pass an `aria-label`. */
  iconOnly?: boolean;
}

function buttonClass({ variant = 'secondary', size = 'md', iconOnly }: ButtonStyleProps, extra?: string) {
  return [
    'btn',
    variant === 'secondary' ? null : variant,
    size === 'sm' ? 'small' : null,
    iconOnly ? 'icon-only' : null,
    extra,
  ]
    .filter(Boolean)
    .join(' ');
}

export function Button({
  variant,
  size,
  icon,
  iconOnly,
  loading = false,
  className,
  disabled,
  type = 'button',
  children,
  ...rest
}: ComponentProps<'button'> & ButtonStyleProps & { loading?: boolean }) {
  return (
    <button
      type={type}
      className={buttonClass({ variant, size, iconOnly }, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <LoaderCircle className="icon spin" aria-hidden="true" /> : icon}
      {children}
    </button>
  );
}

export function ButtonLink({
  variant,
  size,
  icon,
  iconOnly,
  className,
  children,
  ...rest
}: ComponentProps<typeof Link> & ButtonStyleProps) {
  return (
    <Link className={buttonClass({ variant, size, iconOnly }, className)} {...rest}>
      {icon}
      {children}
    </Link>
  );
}
