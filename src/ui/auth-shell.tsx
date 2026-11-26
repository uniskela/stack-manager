import { FilePen, GitCommitHorizontal, Send } from 'lucide-react';
import type { ReactNode } from 'react';
import { Brand, BrandMark } from './brand';

const POINTS = [
  {
    Icon: FilePen,
    title: 'Edit stacks in the browser',
    body: 'Compose files, docs and environment references are saved as drafts until you commit them.',
  },
  {
    Icon: GitCommitHorizontal,
    title: 'Commit with a diff in front of you',
    body: 'Review every change, write the message and push. Conflicts are caught before they reach Git.',
  },
  {
    Icon: Send,
    title: 'Deploy only what changed',
    body: 'Optional webhooks redeploy just the stacks a commit touched.',
  },
];

/** Signed-out and first-run pages: what the app is on the ink panel, the form on paper beside it. */
export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="auth-shell">
      <section className="auth-intro" aria-label="About stack-manager">
        <BrandMark className="auth-ribbon" />
        <Brand />
        <h2>Your Compose repository, edited the way Git expects.</h2>
        <ul className="auth-points">
          {POINTS.map(({ Icon, title, body }) => (
            <li key={title}>
              <Icon className="icon" aria-hidden="true" />
              <span>
                <strong>{title}</strong>
                {body}
              </span>
            </li>
          ))}
        </ul>
        <p className="fine-print">
          Containers stay with Portainer, Komodo or Docker. This app works on source.
        </p>
      </section>
      <main className="auth-main">
        <div className="auth-card">{children}</div>
      </main>
    </div>
  );
}
