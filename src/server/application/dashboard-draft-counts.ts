import { isWithin } from '@/shared/source/paths';

/** Path-only draft metadata: never transfer draft contents to the dashboard. */
export interface DashboardDraftPath {
  repositoryId: string;
  path: string;
}

export interface DashboardDraftStack {
  id: string;
  rootPath: string;
  repository: { id: string; headSha: string | null };
}

export interface DashboardDraftRepository {
  id: string;
  headSha: string | null;
}

export type DraftCountFailure = {
  scope: 'repository' | 'batch';
  repositoryId?: string;
  error: unknown;
};

/**
 * One batched metadata-only query on the successful path, independent of stack count.
 * If it fails, retry independently per repository so a broken repository cannot hide
 * healthy repositories. Missing results are shown as incomplete, never as a false zero.
 */
export async function loadDashboardDraftCounts(
  stacks: readonly DashboardDraftStack[],
  repositories: readonly DashboardDraftRepository[],
  loadDraftPaths: (repositoryIds: readonly string[]) => Promise<DashboardDraftPath[]>,
  onFailure: (failure: DraftCountFailure) => void,
): Promise<{ stackCounts: number[]; openDrafts: number | null; failedCounts: number }> {
  const fetchedRepositories = repositories.filter((repo) => repo.headSha !== null);
  if (fetchedRepositories.length === 0) {
    return { stackCounts: stacks.map(() => 0), openDrafts: 0, failedCounts: 0 };
  }

  let rows: DashboardDraftPath[];
  const failed = new Set<string>();
  try {
    rows = await loadDraftPaths(fetchedRepositories.map((repo) => repo.id));
  } catch (error) {
    onFailure({ scope: 'batch', error });
    const results = await Promise.all(
      fetchedRepositories.map(async (repo) => {
        try {
          return await loadDraftPaths([repo.id]);
        } catch (repositoryError) {
          failed.add(repo.id);
          onFailure({ scope: 'repository', repositoryId: repo.id, error: repositoryError });
          return [];
        }
      }),
    );
    rows = results.flat();
  }

  const validIds = new Set(fetchedRepositories.map((repo) => repo.id));
  const pathsByRepository = new Map<string, string[]>();
  for (const row of rows) {
    if (!validIds.has(row.repositoryId)) continue;
    const paths = pathsByRepository.get(row.repositoryId) ?? [];
    paths.push(row.path);
    pathsByRepository.set(row.repositoryId, paths);
  }

  const stackCounts = stacks.map((stack) => {
    if (stack.repository.headSha === null || failed.has(stack.repository.id)) return 0;
    return (pathsByRepository.get(stack.repository.id) ?? []).filter((path) =>
      isWithin(stack.rootPath, path),
    ).length;
  });
  const openDrafts = failed.size > 0
    ? null
    : [...pathsByRepository.values()].reduce((total, paths) => total + paths.length, 0);

  return { stackCounts, openDrafts, failedCounts: failed.size };
}
