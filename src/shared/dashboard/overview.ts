/** Pure, source-only dashboard aggregation: do not confuse Git sync with runtime health. */
export type DashboardSyncStatus = 'ready' | 'pending' | 'syncing' | 'error';

export interface DashboardRepository {
  id: string;
  name: string;
  syncStatus: DashboardSyncStatus;
  lastSyncError: string | null;
  lastSyncAttemptAt: string | null;
  lastFetchedAt: string | null;
}

export interface DashboardStack {
  id: string;
  name: string;
  repository: { id: string };
}

export interface DashboardOutdatedDraft {
  repositoryId: string;
  path: string;
  stackId?: string;
}

export interface DashboardAttention {
  key: string;
  kind: 'sync-error' | 'outdated';
  label: string;
  detail: string;
  target: { type: 'repository' | 'stack'; id: string };
}

export interface DashboardDraftWork {
  id: string;
  label: string;
  draftCount: number;
}

export function dashboardSyncSummary(repositories: readonly DashboardRepository[]) {
  const counts: Record<DashboardSyncStatus, number> = {
    ready: 0,
    pending: 0,
    syncing: 0,
    error: 0,
  };
  let latestAttempt: string | null = null;
  for (const repo of repositories) {
    counts[repo.syncStatus]++;
    const attempt = repo.lastSyncAttemptAt ?? repo.lastFetchedAt;
    if (attempt && (!latestAttempt || Date.parse(attempt) > Date.parse(latestAttempt))) {
      latestAttempt = attempt;
    }
  }
  return { ...counts, latestAttempt };
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** One row per affected stack, one row per repository error, and grouped unscoped drafts. */
export function dashboardWork(
  repositories: readonly DashboardRepository[],
  stacks: readonly DashboardStack[],
  draftCounts: readonly number[],
  outdatedDrafts: readonly DashboardOutdatedDraft[],
): { attention: DashboardAttention[]; draftsInProgress: DashboardDraftWork[] } {
  const stackById = new Map(stacks.map((stack, index) => [stack.id, { stack, draftCount: draftCounts[index] ?? 0 }]));
  const repoById = new Map(repositories.map((repo) => [repo.id, repo]));
  const stackOutdated = new Map<string, Set<string>>();
  const repositoryOutdated = new Map<string, Set<string>>();

  for (const item of outdatedDrafts) {
    const stack = item.stackId ? stackById.get(item.stackId)?.stack : undefined;
    const target = stack?.repository.id === item.repositoryId ? stackOutdated : repositoryOutdated;
    const key = stack?.repository.id === item.repositoryId ? stack.id : item.repositoryId;
    const paths = target.get(key) ?? new Set<string>();
    paths.add(item.path);
    target.set(key, paths);
  }

  const attention: DashboardAttention[] = [];
  for (const repo of repositories) {
    if (repo.syncStatus === 'error') {
      attention.push({
        key: `sync-${repo.id}`,
        kind: 'sync-error',
        label: repo.name,
        detail: repo.lastSyncError || 'Repository fetch failed',
        target: { type: 'repository', id: repo.id },
      });
    }
  }
  const draftsInProgress: DashboardDraftWork[] = [];
  for (const [id, { stack, draftCount }] of stackById) {
    const outdated = stackOutdated.get(id)?.size ?? 0;
    if (outdated) {
      attention.push({
        key: `outdated-stack-${id}`,
        kind: 'outdated',
        label: stack.name,
        detail: `${plural(outdated, 'outdated draft')}${draftCount ? ` · ${plural(draftCount, 'open draft')}` : ''}`,
        target: { type: 'stack', id },
      });
    } else if (draftCount > 0) {
      draftsInProgress.push({ id, label: stack.name, draftCount });
    }
  }
  for (const [repositoryId, paths] of repositoryOutdated) {
    attention.push({
      key: `outdated-repo-${repositoryId}`,
      kind: 'outdated',
      label: repoById.get(repositoryId)?.name ?? 'Repository',
      detail: `${plural(paths.size, 'outdated draft')} outside stacks`,
      target: { type: 'repository', id: repositoryId },
    });
  }
  return { attention, draftsInProgress };
}

/** Hide routine connection tests and repeated fetch requests from the home feed; keep full audit elsewhere. */
export function dashboardRecentActivity<T extends { action: string; outcome: string }>(
  events: readonly T[],
  limit = 5,
): T[] {
  const routineActions = new Set([
    'repository.sync_requested',
    'repository.test',
    'auth.login',
    'auth.logout',
  ]);
  return events.filter((event) => event.outcome === 'failure' || !routineActions.has(event.action)).slice(0, limit);
}
