'use client';

import Link from 'next/link';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { resolveRepoLink, type LinkContext } from '@/shared/source/links';

const isExternal = (href: string) => /^https?:\/\//i.test(href);

const makeComponents = (ctx: LinkContext | undefined): Components => ({
  a: ({ href = '', children }) => {
    if (isExternal(href)) {
      return (
        <a href={href} target="_blank" rel="noopener noreferrer">
          {children}
        </a>
      );
    }
    if (/^mailto:/i.test(href) || href.startsWith('#')) return <a href={href}>{children}</a>;
    const relative = !/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('/');
    const internal = ctx && relative ? resolveRepoLink(href, ctx) : null;
    return internal ? <Link href={internal}>{children}</Link> : <span className="muted">{children}</span>;
  },
  // Wide code blocks and tables scroll horizontally, so they must be reachable by keyboard.
  pre: ({ children }) => <pre tabIndex={0}>{children}</pre>,
  table: ({ children }) => (
    <div className="table-scroll" tabIndex={0} role="region" aria-label="Table">
      <table>{children}</table>
    </div>
  ),
  img: ({ src, alt }) =>
    typeof src === 'string' && src.startsWith('https://') ? (
      // eslint-disable-next-line @next/next/no-img-element -- remote documentation images, not app assets
      <img src={src} alt={alt ?? ''} loading="lazy" referrerPolicy="no-referrer" />
    ) : (
      <span className="muted">[image: {alt || 'untitled'}]</span>
    ),
});

export function MarkdownView({ source, links }: { source: string; links?: LinkContext }) {
  return (
    <div className="prose">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={makeComponents(links)}>
        {source}
      </ReactMarkdown>
    </div>
  );
}
