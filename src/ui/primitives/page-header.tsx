import type { ReactNode } from 'react';

/** Standard page heading: optional breadcrumbs, title with status, description and page-level actions. */
export function PageHeader({
  title,
  description,
  status,
  actions,
  breadcrumbs,
}: {
  title: ReactNode;
  description?: ReactNode;
  status?: ReactNode;
  actions?: ReactNode;
  breadcrumbs?: ReactNode;
}) {
  return (
    <div className="page-head">
      {breadcrumbs}
      <div className="page-head-row">
        <div className="page-head-text">
          <div className="page-title-row">
            <h1 className="truncate">{title}</h1>
            {status}
          </div>
          {description ? <div className="muted page-desc">{description}</div> : null}
        </div>
        {actions ? <div className="actions">{actions}</div> : null}
      </div>
    </div>
  );
}
