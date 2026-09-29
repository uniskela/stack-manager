import type { ReactNode } from 'react';

/** A titled card. `id` names the heading so the section is a labelled landmark region. */
export function Section({
  id,
  title,
  description,
  actions,
  footer,
  flush = false,
  children,
}: {
  id: string;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  flush?: boolean;
  children?: ReactNode;
}) {
  return (
    <section className={flush ? 'card flush' : 'card'} aria-labelledby={id}>
      <div className="section-head">
        <div>
          <h2 id={id}>{title}</h2>
          {description ? <p className="muted">{description}</p> : null}
        </div>
        {actions ? <div className="actions">{actions}</div> : null}
      </div>
      {children}
      {footer ? <div className="section-footer">{footer}</div> : null}
    </section>
  );
}

/** Heading for content that sits outside a card, e.g. a list or table. */
export function SectionTitle({ id, title, aside }: { id: string; title: ReactNode; aside?: ReactNode }) {
  return (
    <div className="section-title">
      <h2 id={id}>{title}</h2>
      {aside ? <span className="fine-print">{aside}</span> : null}
    </div>
  );
}
