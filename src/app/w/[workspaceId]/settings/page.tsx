import type { Metadata } from 'next';
import { getContainer } from '@/server/container';
import { CredentialActions } from '@/ui/credential-actions';
import { LocalTime } from '@/ui/local-time';
import { PageHeader } from '@/ui/primitives/page-header';
import { Section, SectionTitle } from '@/ui/primitives/section';
import { StatusPill } from '@/ui/primitives/status-pill';
import { TableWrap } from '@/ui/primitives/table-wrap';
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
      <PageHeader title="Settings" />

      <Section id="ws-general" title="Workspace">
        <RenameWorkspaceForm workspaceId={workspace.id} initialName={workspace.name} />
      </Section>

      <SectionTitle
        id="ws-credentials"
        title="Provider credentials"
        aside="Encrypted at rest · never shown after saving"
      />
      {credentials.length === 0 ? (
        <p className="muted">No credentials yet. Tokens added while connecting a repository appear here.</p>
      ) : (
        <ul className="list" aria-labelledby="ws-credentials">
          {credentials.map((c) => (
            <li key={c.id} className="list-row wrap">
              <div className="grow">
                <div className="title">{c.label}</div>
                <div className="list-row-sub">
                  {c.kind} · {c.providerType} · <span className="mono">{c.hint}</span>
                  {c.meta.username ? ` · user ${c.meta.username}` : ''} · updated{' '}
                  <LocalTime iso={c.updatedAt} />
                </div>
                {c.lastTestStatus ? (
                  <div className="list-row-sub">
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

      <SectionTitle id="ws-activity" title="Recent activity" />
      {events.length === 0 ? (
        <p className="muted">No activity yet.</p>
      ) : (
        <TableWrap labelledBy="ws-activity">
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
        </TableWrap>
      )}
    </>
  );
}
