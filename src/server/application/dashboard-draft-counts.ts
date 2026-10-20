/** Load dashboard counters without a failure in one repository hiding all the others. */
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
  scope: 'stack' | 'repository';
  id: string;
  repositoryId: string;
  error: unknown;
};

export async function loadDashboardDraftCounts(
  stacks: readonly DashboardDraftStack[],
  repositories: readonly DashboardDraftRepository[],
  countDrafts: (repositoryId: string, rootPath: string) => Promise<number>,
  onFailure: (failure: DraftCountFailure) => void,
): Promise<{ stackCounts: number[]; openDrafts: number | null; failedCounts: number }> {
  const count = async (
    scope: DraftCountFailure['scope'],
    id: string,
    repositoryId: string,
    rootPath: string,
    fetched: boolean,
  ): Promise<number | null> => {
    if (!fetched) return 0;
    try {
      return await countDrafts(repositoryId, rootPath);
    } catch (error) {
      onFailure({ scope, id, repositoryId, error });
      return null;
    }
  };

  const [stackResults, repositoryResults] = await Promise.all([
    Promise.all(
      stacks.map((stack) =>
        count('stack', stack.id, stack.repository.id, stack.rootPath, stack.repository.headSha !== null),
      ),
    ),
    Promise.all(
      repositories.map((repository) =>
        count('repository', repository.id, repository.id, '', repository.headSha !== null),
      ),
    ),
  ]);
  return {
    // Count failures are explicitly signalled; zero is only used to omit an unverified stack row.
    stackCounts: stackResults.map((value) => value ?? 0),
    openDrafts: repositoryResults.some((value) => value === null)
      ? null
      : repositoryResults.reduce<number>((sum, value) => sum + (value ?? 0), 0),
    failedCounts: [...stackResults, ...repositoryResults].filter((value) => value === null).length,
  };
}
