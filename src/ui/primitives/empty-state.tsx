import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

export function EmptyState({
  icon: Icon,
  title,
  headingLevel = 2,
  actions,
  children,
}: {
  icon?: LucideIcon;
  title: ReactNode;
  headingLevel?: 1 | 2;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const Heading = headingLevel === 1 ? 'h1' : 'h2';
  return (
    <div className="card empty">
      {Icon ? <Icon className="empty-icon" aria-hidden="true" /> : null}
      <Heading>{title}</Heading>
      {children ? <p className="muted">{children}</p> : null}
      {actions ? <div className="actions">{actions}</div> : null}
    </div>
  );
}
