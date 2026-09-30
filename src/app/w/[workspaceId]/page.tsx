import { FolderGit2, Layers, Settings } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { getContainer } from '@/server/container';
import { auditActionLabel } from '@/shared/audit/labels';
import { auditEntityHref } from '@/shared/audit/links';
import { LocalTime } from '@/ui/local-time';
import { ButtonLink } from '@/ui/primitives/button';
import { EmptyState } from '@/ui/primitives/empty-state';
import { PageHeader } from '@/ui/primitives/page-header';
import { SectionTitle } from '@/ui/primitives/section';
import { TableWrap } from '@/ui/primitives/table-wrap';

export const metadata: Metadata = { title: 'Dashboard' };

type SyncStatus = 'pending' | 'syncing' | 'ready' | 'error';

function syncBreakdown(repositories: { syncStatus: SyncStatus }[]) {
  const counts: Record<SyncStatus, number> = { ready: 0, syncing: 0, error: 0, pending: 0 };
  for (const r of repositories) counts[r.syncStatus]++;
  return counts;
}

export default async function DashboardPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const container = getContainer();
  const connectHref = `/w/${workspaceId}/repositories/new`;
  const base = `/w/${workspaceId}`;

  const [workspace, repositories, stackList, events, outdatedDrafts] = await Promise.all([
    container.workspaces.get(workspaceId),
    container.repositories.list(workspaceId),
    container.stacks.list(workspaceId),
    container.audit.list({ workspaceId, limit: 8 }),
    container.source.listOutdatedDraftSummaries(workspaceId),
  ]);

  if (repositories.length === 0) {
    return (
      <EmptyState
        icon={FolderGit2}
        headingLevel={1}
        title="Connect your Compose repository"
        actions={
          <ButtonLink variant="primary" href={connectHref}>
            Connect repository
          </ButtonLink>
        }
      >
        stack-manager works from the Git repository that describes your stacks. Connect it over HTTPS; a
        read-only token is enough to start.
      </EmptyState>
    );
  }

  // Stack-scoped counts drive attention rows; repo-wide totals include drafts outside any stack.
  const [draftCounts, openDrafts] = await Promise.all([
    Promise.all(
      stackList.map((s) =>
        s.repository.headSha
          ? container.source.countDrafts(s.repository.id, s.rootPath)
          : Promise.resolve(0),
      ),
    ),
    Promise.all(
      repositories.map((r) =>
        r.headSha ? container.source.countDrafts(r.id, '') : Promise.resolve(0),
      ),
    ).then((counts) => counts.reduce((n, c) => n + c, 0)),
  ]);
  const stacksWithDrafts = stackList.filter((_, i) => (draftCounts[i] ?? 0) > 0);
  const sync = syncBreakdown(repositories);
  const errorRepos = repositories.filter((r) => r.syncStatus === 'error');

  type AttentionRow = { key: string; label: string; detail?: string; href: string };
  const attention: AttentionRow[] = [];
  for (const repo of errorRepos) {
    attention.push({
      key: `sync-${repo.id}`,
      label: repo.name,
      detail: repo.lastSyncError ?? 'Fetch failed',
      href: `${base}/repositories/${repo.id}`,
    });
  }
  for (const stack of stacksWithDrafts) {
    const i = stackList.indexOf(stack);
    attention.push({
      key: `drafts-${stack.id}`,
      label: stack.name,
      detail: `${draftCounts[i] ?? 0} open draft${(draftCounts[i] ?? 0) === 1 ? '' : 's'}`,
      href: `${base}/stacks/${stack.id}`,
    });
  }
  for (const item of outdatedDrafts) {
    const stack = item.stackId ? stackList.find((s) => s.id === item.stackId) : undefined;
    attention.push({
      key: `outdated-${item.repositoryId}-${item.path}`,
      label: stack?.name ?? item.path,
      detail: stack ? `Outdated draft · ${item.path}` : 'Outdated draft',
      href: item.stackId ? `${base}/stacks/${item.stackId}` : `${base}/repositories/${item.repositoryId}`,
    });
  }

  return (
    <>
      <PageHeader title={workspace.name} description="Source workspace overview" />

      <div className="card flush dashboard-summary">
        <p className="dashboard-summary-line">
          <strong>{repositories.length}</strong> {repositories.length === 1 ? 'repository' : 'repositories'}
          {' · '}
          <strong>{stackList.length}</strong> {stackList.length === 1 ? 'stack' : 'stacks'}
          {' · '}
          <strong>{openDrafts}</strong> open {openDrafts === 1 ? 'draft' : 'drafts'}
        </p>
        <p className="fine-print dashboard-sync-line">
          Sync: {sync.ready} ready · {sync.syncing} syncing · {sync.error} error · {sync.pending} pending
        </p>
      </div>

      <SectionTitle id="dash-attention" title="Needs attention" />
      {attention.length === 0 ? (
        <p className="muted">Nothing needs attention.</p>
      ) : (
        <ul className="list" aria-labelledby="dash-attention">
          {attention.map((row) => (
            <li key={row.key}>
              <Link className="list-row stack-on-mobile" href={row.href}>
                <div className="grow">
                  <div className="title">{row.label}</div>
                  {row.detail ? <div className="list-row-sub muted">{row.detail}</div> : null}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <SectionTitle id="dash-shortcuts" title="Shortcuts" />
      <div className="actions dashboard-shortcuts" aria-labelledby="dash-shortcuts">
        <ButtonLink href={`${base}/stacks`} icon={<Layers className="icon" aria-hidden="true" />}>
          Stacks
        </ButtonLink>
        <ButtonLink href={`${base}/repositories`} icon={<FolderGit2 className="icon" aria-hidden="true" />}>
          Repositories
        </ButtonLink>
        <ButtonLink href={`${base}/settings`} icon={<Settings className="icon" aria-hidden="true" />}>
          Settings
        </ButtonLink>
      </div>

      <SectionTitle id="dash-activity" title="Recent activity" />
      {events.length === 0 ? (
        <p className="muted">No activity yet.</p>
      ) : (
        <TableWrap labelledBy="dash-activity">
          <table className="simple" aria-labelledby="dash-activity">
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
                    <td>{e.outcome}</td>
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
