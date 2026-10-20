import type { Metadata } from 'next';
import Link from 'next/link';
import { getContainer } from '@/server/container';
import { dashboardRecentActivity, dashboardSyncSummary, dashboardWork } from '@/shared/dashboard/overview';
import { auditActionLabel } from '@/shared/audit/labels';
import { auditEntityHref } from '@/shared/audit/links';
import { DashboardFetchAction } from '@/ui/dashboard-fetch-action';
import { LocalTime } from '@/ui/local-time';
import { ButtonLink } from '@/ui/primitives/button';
import { EmptyState } from '@/ui/primitives/empty-state';
import { PageHeader } from '@/ui/primitives/page-header';
import { SectionTitle } from '@/ui/primitives/section';
import { FolderGit2 } from 'lucide-react';

export const metadata: Metadata = { title: 'Dashboard' };

export default async function DashboardPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const container = getContainer();
  const base = `/w/${workspaceId}`;

  const [workspace, repositories, stackList, events, outdatedDrafts] = await Promise.all([
    container.workspaces.get(workspaceId),
    container.repositories.list(workspaceId),
    container.stacks.list(workspaceId),
    container.audit.list({ workspaceId, limit: 30 }),
    container.source.listOutdatedDraftSummaries(workspaceId),
  ]);

  if (repositories.length === 0) {
    return (
      <EmptyState
        icon={FolderGit2}
        headingLevel={1}
        title="Connect your Compose repository"
        actions={
          <ButtonLink variant="primary" href={`${base}/repositories/new`}>
            Connect repository
          </ButtonLink>
        }
      >
        stack-manager works from the Git repository that describes your stacks. Connect it over HTTPS; a
        read-only token is enough to start.
      </EmptyState>
    );
  }

  // Source drafts are counted repository-wide, including files outside registered stacks.
  const [draftCounts, openDrafts] = await Promise.all([
    Promise.all(
      stackList.map((stack) =>
        stack.repository.headSha
          ? container.source.countDrafts(stack.repository.id, stack.rootPath)
          : Promise.resolve(0),
      ),
    ),
    Promise.all(
      repositories.map((repo) => (repo.headSha ? container.source.countDrafts(repo.id, '') : Promise.resolve(0))),
    ).then((counts) => counts.reduce((sum, count) => sum + count, 0)),
  ]);

  const sync = dashboardSyncSummary(repositories);
  const work = dashboardWork(repositories, stackList, draftCounts, outdatedDrafts);
  const activity = dashboardRecentActivity(events);
  const oneRepository = repositories.length === 1 ? repositories[0] : null;
  const visibleAttention = work.attention.slice(0, 8);
  const visibleDrafts = work.draftsInProgress.slice(0, 4);

  return (
    <>
      <PageHeader
        title={workspace.name}
        description="Git source workspace · Sync status, drafts and recent changes"
        actions={
          oneRepository ? (
            <DashboardFetchAction workspaceId={workspaceId} repositoryId={oneRepository.id} />
          ) : undefined
        }
      />

      <section aria-label="Workspace summary" className="dashboard-overview">
        <dl className="dashboard-metrics">
          <div className="dashboard-metric">
            <dt>Repositories</dt>
            <dd>{repositories.length}</dd>
          </div>
          <div className="dashboard-metric">
            <dt>Stacks</dt>
            <dd>{stackList.length}</dd>
          </div>
          <div className="dashboard-metric">
            <dt>Open drafts</dt>
            <dd>{openDrafts}</dd>
          </div>
          <div className="dashboard-metric">
            <dt>Sync errors</dt>
            <dd>{sync.error}</dd>
          </div>
        </dl>
        <div className="dashboard-source-status">
          <span>
            <strong>Source sync:</strong> {sync.ready} ready · {sync.syncing} syncing · {sync.pending} queued
            {sync.error ? ` · ${sync.error} failed` : ''}
          </span>
          <span>
            <strong>Latest sync attempt:</strong> <LocalTime iso={sync.latestAttempt} />
          </span>
        </div>
        <p className="fine-print dashboard-source-note">
          These are Git source states, not container health or deployment status.
        </p>
      </section>

      <SectionTitle
        id="dash-attention"
        title="Needs attention"
        aside={`${work.attention.length} ${work.attention.length === 1 ? 'item' : 'items'}`}
      />
      {work.attention.length === 0 ? (
        <p className="muted">No sync failures or outdated drafts need action.</p>
      ) : (
        <>
          <ul className="list dashboard-attention-list" aria-labelledby="dash-attention">
            {visibleAttention.map((item) => (
              <li key={item.key}>
                <Link className="list-row dashboard-attention-row" href={`${base}/${item.target.type === 'stack' ? 'stacks' : 'repositories'}/${item.target.id}`}>
                  <div className="grow">
                    <span className="dashboard-row-heading">
                      <span className="title">{item.label}</span>
                      <span className={item.kind === 'sync-error' ? 'dashboard-kind dashboard-kind-error' : 'dashboard-kind'}>
                        {item.kind === 'sync-error' ? 'Sync failed' : 'Outdated drafts'}
                      </span>
                    </span>
                    <span className="list-row-sub muted">{item.detail}</span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
          {work.attention.length > visibleAttention.length ? (
            <p className="dashboard-list-more muted">
              Showing {visibleAttention.length} of {work.attention.length} issues. Review{' '}
              <Link href={`${base}/stacks`}>Stacks</Link> and{' '}
              <Link href={`${base}/repositories`}>Repositories</Link> for the rest.
            </p>
          ) : null}
        </>
      )}

      {work.draftsInProgress.length > 0 ? (
        <>
          <SectionTitle
            id="dash-drafts"
            title="Work in progress"
            aside={<Link href={`${base}/stacks?drafts=1`}>View stacks with drafts</Link>}
          />
          <ul className="list" aria-labelledby="dash-drafts">
            {visibleDrafts.map((item) => (
              <li key={item.id}>
                <Link className="list-row" href={`${base}/stacks/${item.id}`}>
                  <span className="grow title">{item.label}</span>
                  <span className="list-row-meta">
                    {item.draftCount} open {item.draftCount === 1 ? 'draft' : 'drafts'}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {work.draftsInProgress.length > visibleDrafts.length ? (
            <p className="dashboard-list-more muted">
              Showing {visibleDrafts.length} of {work.draftsInProgress.length} stacks with drafts.
            </p>
          ) : null}
        </>
      ) : null}

      <SectionTitle
        id="dash-activity"
        title="Recent activity"
        aside={<Link href={`${base}/settings/activity`}>View all activity</Link>}
      />
      {activity.length === 0 ? (
        <p className="muted">No meaningful changes yet. Full audit events remain in Settings → Activity.</p>
      ) : (
        <ol className="list dashboard-activity" aria-labelledby="dash-activity">
          {activity.map((event) => {
            const href = auditEntityHref(workspaceId, event.entityType, event.entityId);
            return (
              <li key={event.id} className="dashboard-activity-row">
                <span className="dashboard-activity-main">
                  {href ? (
                    <Link href={href}>{auditActionLabel(event.action)}</Link>
                  ) : (
                    <span>{auditActionLabel(event.action)}</span>
                  )}
                  {event.outcome === 'failure' ? <span className="dashboard-kind dashboard-kind-error">Failed</span> : null}
                </span>
                <LocalTime iso={event.createdAt.toISOString()} />
              </li>
            );
          })}
        </ol>
      )}
    </>
  );
}
