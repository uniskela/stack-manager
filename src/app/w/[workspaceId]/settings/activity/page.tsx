import Link from 'next/link';
import { getContainer } from '@/server/container';
import { auditActionLabel } from '@/shared/audit/labels';
import { auditEntityHref } from '@/shared/audit/links';
import { LocalTime } from '@/ui/local-time';
import { SectionTitle } from '@/ui/primitives/section';
import { StatusPill } from '@/ui/primitives/status-pill';
import { TableWrap } from '@/ui/primitives/table-wrap';

export default async function SettingsActivityPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const events = await getContainer().audit.list({ workspaceId, limit: 25 });

  return (
    <>
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
                <th scope="col">Target</th>
                <th scope="col">Outcome</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => {
                const href = auditEntityHref(workspaceId, e.entityType, e.entityId);
                const pathMeta = typeof e.meta.path === 'string' ? e.meta.path : null;
                return (
                  <tr key={e.id}>
                    <td>
                      <LocalTime iso={e.createdAt.toISOString()} />
                    </td>
                    <td>{auditActionLabel(e.action)}</td>
                    <td>
                      {href ? (
                        <Link href={href}>{pathMeta ? `${e.entityType} · ${pathMeta}` : e.entityType}</Link>
                      ) : pathMeta ? (
                        <span className="mono">{pathMeta}</span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>
                      <StatusPill status={e.outcome} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableWrap>
      )}
    </>
  );
}
