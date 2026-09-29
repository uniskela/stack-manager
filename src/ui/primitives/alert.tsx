import { CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';

export type AlertTone = 'info' | 'ok' | 'warn' | 'error';

const ICONS = { info: Info, ok: CircleCheck, warn: TriangleAlert, error: CircleAlert } as const;

/**
 * Inline message tied to the content around it. Pass `role="alert"` for errors that appear in response to
 * an action and `role="status"` for confirmations; omit it for messages present on page load.
 */
export function Alert({
  tone = 'info',
  title,
  role,
  children,
}: {
  tone?: AlertTone;
  title?: ReactNode;
  role?: 'alert' | 'status';
  children?: ReactNode;
}) {
  const Icon = ICONS[tone];
  return (
    <div className={`alert ${tone}`} role={role}>
      <Icon className="icon" aria-hidden="true" />
      <div className="alert-body">
        {title ? <div className="alert-title">{title}</div> : null}
        {children}
      </div>
    </div>
  );
}
