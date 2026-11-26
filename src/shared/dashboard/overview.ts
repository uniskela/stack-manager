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
  const stackById = new Map(
    stacks.map((stack, index) => [stack.id, { stack, draftCount: draftCounts[index] ?? 0 }]),
  );
  const repoById = new Map(repositories.map((repo) => [repo.id, repo]));
  const stackOutdated = new Map<string, Set<string>>();
  const repositoryOutdated = new Map<string, Set<string>>();

  for (const item of outdatedDrafts) {
    const stack = item.stackId ? stackById.get(item.stackId)?.stack : undefined;
    const validStack = stack?.repository.id === item.repositoryId;
    const target = validStack ? stackOutdated : repositoryOutdated;
    const key = validStack && stack ? stack.id : item.repositoryId;
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
      const draftDetail = draftCount ? ` · ${plural(draftCount, 'open draft')}` : '';
      attention.push({
        key: `outdated-stack-${id}`,
        kind: 'outdated',
        label: stack.name,
        detail: `${plural(outdated, 'outdated draft')}${draftDetail}`,
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

/** Successful routine events are excluded by SQL before LIMIT, preserving their failures. */
export const DASHBOARD_ROUTINE_ACTIONS = [
  'deployment.routing_evaluated',
  'deployment.stack_skipped',
  'repository.sync_requested',
  'repository.test',
  'auth.login',
  'auth.logout',
] as const;

/** Defensive UI filter: the SQL query normally excludes these before applying LIMIT. */
export function dashboardRecentActivity<T extends { action: string; outcome: string }>(
  events: readonly T[],
  limit = 5,
): T[] {
  const routineActions = new Set<string>(DASHBOARD_ROUTINE_ACTIONS);
  return events
    .filter((event) => event.outcome === 'failure' || !routineActions.has(event.action))
    .slice(0, limit);
}

export interface DashboardNextStep {
  tone: 'error' | 'warn' | 'progress' | 'calm';
  title: string;
  body: string;
  action?: {
    label: string;
    target: {
      type: 'repository' | 'repository-changes' | 'stack' | 'stacks-with-drafts' | 'stacks';
      id?: string;
    };
  };
}

/** Drafts per repository; `outsideStacks` are drafts no stack folder contains (repo-level docs and the like). */
export interface DashboardRepositoryDrafts {
  id: string;
  name: string;
  drafts: number;
  outsideStacks: number;
}

/**
 * The single most useful thing to do next, for people who are new to the Git workflow. Failures outrank
 * drafts changed upstream, which outrank open drafts. `openDrafts` is null when counts could not be loaded,
 * so the calm "everything committed" message is never shown on incomplete data.
 */
export function dashboardNextStep(input: {
  attention: readonly DashboardAttention[];
  openDrafts: number | null;
  draftsInProgress: readonly DashboardDraftWork[];
  draftRepositories?: readonly DashboardRepositoryDrafts[];
  stackCount: number;
}): DashboardNextStep {
  const failures = input.attention.filter((item) => item.kind === 'sync-error');
  const outdated = input.attention.filter((item) => item.kind === 'outdated');
  const first = failures[0];
  if (first) {
    return {
      tone: 'error',
      title:
        failures.length === 1
          ? `${first.label} could not be fetched`
          : `${failures.length} repositories could not be fetched`,
      body: 'Edits stay safe as drafts, but stacks show the last fetched commit until Git is reachable again. Open the repository to see the error and test its credential.',
      action: { label: 'Open repository', target: first.target },
    };
  }
  const firstOutdated = outdated[0];
  if (firstOutdated) {
    return {
      tone: 'warn',
      title:
        outdated.length === 1
          ? `Drafts in ${firstOutdated.label} changed upstream`
          : `Drafts in ${outdated.length} places changed upstream`,
      body: 'Someone committed to these files after you started editing. Compare your draft with the new version before you commit.',
      action: {
        label: firstOutdated.target.type === 'stack' ? 'Open stack' : 'Open repository',
        target: firstOutdated.target,
      },
    };
  }
  if (input.openDrafts === null) {
    return {
      tone: 'warn',
      title: 'Draft counts are unavailable',
      body: 'Some repositories could not report their drafts. Open Stacks to check for unsaved work.',
      action: { label: 'Open stacks', target: { type: 'stacks' } },
    };
  }
  if (input.openDrafts > 0) {
    return {
      tone: 'progress',
      title: `${plural(input.openDrafts, 'draft')} ready to review`,
      body: 'Drafts stay on this server until you commit them. Review the changes, then commit and push them to Git.',
      action: draftAction(input.draftsInProgress, input.draftRepositories ?? []),
    };
  }
  if (input.stackCount === 0) {
    return {
      tone: 'calm',
      title: 'No stacks found yet',
      body: 'A stack is a folder with a Compose file. Check the stack folder in the repository settings, or add a Compose file to Git and fetch again.',
      action: { label: 'Open stacks', target: { type: 'stacks' } },
    };
  }
  return {
    tone: 'calm',
    title: 'Everything is committed',
    body: 'Open a stack to edit its Compose file, docs or environment. Your edits are saved as drafts until you commit them.',
    action: { label: 'Browse stacks', target: { type: 'stacks' } },
  };
}

/**
 * Where "review drafts" should go. A stack filter cannot show drafts outside every stack folder, so those go to
 * their repository's Changes page, which lists every draft and is where they are committed.
 */
function draftAction(
  stacks: readonly DashboardDraftWork[],
  repositories: readonly DashboardRepositoryDrafts[],
): NonNullable<DashboardNextStep['action']> {
  const withDrafts = repositories.filter((repo) => repo.drafts > 0);
  const outside = withDrafts.find((repo) => repo.outsideStacks > 0);
  const target = outside ?? (stacks.length === 0 ? withDrafts[0] : undefined);
  if (target) {
    return {
      label: withDrafts.length === 1 ? 'Review changes' : `Review changes in ${target.name}`,
      target: { type: 'repository-changes', id: target.id },
    };
  }
  const onlyStack = stacks.length === 1 ? stacks[0] : undefined;
  return onlyStack
    ? { label: `Open ${onlyStack.label}`, target: { type: 'stack', id: onlyStack.id } }
    : { label: 'Stacks with drafts', target: { type: 'stacks-with-drafts' } };
}
