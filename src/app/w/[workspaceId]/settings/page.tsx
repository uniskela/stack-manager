import type { Metadata } from 'next';
import { getContainer } from '@/server/container';
import { CredentialActions } from '@/ui/credential-actions';
import { LocalTime } from '@/ui/local-time';
import { StatusPill } from '@/ui/status-pill';
import { RenameWorkspaceForm } from '@/ui/workspace-form';

export const metadata: Metadata = { title: 'Settings' };

export default async function SettingsPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const container = getContainer();
  const [workspace, credentials, repositories, events] = await Promise.all([
    container.workspaces.get(workspaceId),
    container.credentials.list(workspaceId),
    container.repositories.list(workspaceId),
    container.audit.list({ workspaceId, limit: 25 }),
  ]);
  const inUse = new Set(repositories.map((r) => r.credential?.id).filter(Boolean));

  return (
    <>
      <div className="page-head">
        <h1>Settings</h1>
      </div>

      <section className="card" aria-labelledby="ws-general">
        <h2 id="ws-general">Workspace</h2>
        <RenameWorkspaceForm workspaceId={workspace.id} initialName={workspace.name} />
      </section>

      <div className="section-title">
        <h2 id="ws-credentials">Provider credentials</h2>
        <span className="muted" style={{ fontSize: '0.85rem' }}>
          Encrypted at rest · never shown after saving
        </span>
      </div>
      {credentials.length === 0 ? (
        <p className="muted">No credentials yet. Tokens added while connecting a repository appear here.</p>
      ) : (
        <ul className="list" aria-labelledby="ws-credentials">
          {credentials.map((c) => (
            <li key={c.id} className="list-row" style={{ flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <div className="grow">
                <div className="title">{c.label}</div>
                <div className="muted" style={{ fontSize: '0.88rem' }}>
                  {c.kind} · {c.providerType} · <span className="mono">{c.hint}</span>
                  {c.meta.username ? ` · user ${c.meta.username}` : ''} · updated{' '}
                  <LocalTime iso={c.updatedAt} />
                </div>
                {c.lastTestStatus ? (
                  <div style={{ marginTop: '0.35rem' }}>
                    <StatusPill status={c.lastTestStatus} /> <LocalTime iso={c.lastTestedAt} />
                  </div>
                ) : null}
              </div>
              <CredentialActions
                workspaceId={workspaceId}
                credentialId={c.id}
                allowDelete={!inUse.has(c.id)}
              />
            </li>
          ))}
        </ul>
      )}

      <div className="section-title">
        <h2 id="ws-activity">Recent activity</h2>
      </div>
      {events.length === 0 ? (
        <p className="muted">No activity yet.</p>
      ) : (
        <div className="table-wrap card" style={{ padding: 0 }}>
          <table className="simple" aria-labelledby="ws-activity">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Action</th>
                <th scope="col">Outcome</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id}>
                  <td>
                    <LocalTime iso={e.createdAt.toISOString()} />
                  </td>
                  <td className="mono">{e.action}</td>
                  <td>{e.outcome}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
