import { describe, expect, it, vi } from 'vitest';
import {
  loadDashboardDraftCounts,
  type DashboardDraftPath,
} from '@/server/application/dashboard-draft-counts';

const repositories = [
  { id: 'r1', headSha: 'a'.repeat(40) },
  { id: 'r2', headSha: 'b'.repeat(40) },
];
const stacks = [
  { id: 's1', rootPath: 'apps/one', repository: { id: 'r1', headSha: repositories[0]!.headSha } },
  { id: 's2', rootPath: 'apps/two', repository: { id: 'r2', headSha: repositories[1]!.headSha } },
];

const rows: DashboardDraftPath[] = [
  { repositoryId: 'r1', path: 'apps/one/compose.yml' },
  { repositoryId: 'r1', path: 'apps/one/config.json' },
  { repositoryId: 'r1', path: 'apps/one-extra/compose.yml' },
  { repositoryId: 'r2', path: 'apps/two/compose.yml' },
];

describe('loadDashboardDraftCounts', () => {
  it('uses one metadata query for every stack and repository, with path-boundary checks', async () => {
    const query = vi.fn(async () => rows);
    const result = await loadDashboardDraftCounts(stacks, repositories, query, vi.fn());
    expect(result).toEqual({ stackCounts: [2, 1], openDrafts: 4, failedCounts: 0 });
    expect(query).toHaveBeenCalledExactlyOnceWith(['r1', 'r2']);
  });

  it('falls back per repository when the single batch query fails', async () => {
    const onFailure = vi.fn();
    const query = vi.fn(async (ids: readonly string[]) => {
      if (ids.length > 1) throw new Error('batch unavailable');
      if (ids[0] === 'r2') throw new Error('repository r2 unavailable');
      return rows.filter((row) => row.repositoryId === ids[0]);
    });
    const result = await loadDashboardDraftCounts(stacks, repositories, query, onFailure);
    expect(result).toEqual({ stackCounts: [2, 0], openDrafts: null, failedCounts: 1 });
    expect(query).toHaveBeenCalledTimes(3);
    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({ scope: 'batch' }));
    expect(onFailure).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'repository', repositoryId: 'r2' }),
    );
  });

  it('keeps accurate totals after batch recovery if every individual read succeeds', async () => {
    const query = vi.fn(async (ids: readonly string[]) => {
      if (ids.length > 1) throw new Error('batch failure');
      return rows.filter((row) => row.repositoryId === ids[0]);
    });
    const result = await loadDashboardDraftCounts(stacks, repositories, query, vi.fn());
    expect(result).toEqual({ stackCounts: [2, 1], openDrafts: 4, failedCounts: 0 });
  });

  it('does not count drafts from unknown or unfetched repositories', async () => {
    const query = vi.fn(async () => [
      ...rows,
      { repositoryId: 'unexpected', path: 'apps/secret' },
      { repositoryId: 'r3', path: 'apps/not-yet-fetched' },
    ]);
    const result = await loadDashboardDraftCounts(
      stacks,
      [...repositories, { id: 'r3', headSha: null }],
      query,
      vi.fn(),
    );
    expect(result).toEqual({ stackCounts: [2, 1], openDrafts: 4, failedCounts: 0 });
    expect(query).toHaveBeenCalledExactlyOnceWith(['r1', 'r2']);
  });

  it('does not issue SQL queries when repositories have not been fetched', async () => {
    const query = vi.fn(async () => rows);
    const result = await loadDashboardDraftCounts(
      [{ id: 's', rootPath: '', repository: { id: 'r', headSha: null } }],
      [{ id: 'r', headSha: null }],
      query,
      vi.fn(),
    );
    expect(result).toEqual({ stackCounts: [0], openDrafts: 0, failedCounts: 0 });
    expect(query).not.toHaveBeenCalled();
  });

  it('supports repository-root stacks and overlapping scoped paths', async () => {
    const result = await loadDashboardDraftCounts(
      [
        { id: 'root', rootPath: '', repository: repositories[0]! },
        { id: 'parent', rootPath: 'apps', repository: repositories[0]! },
        { id: 'nested', rootPath: 'apps/one', repository: repositories[0]! },
      ],
      [repositories[0]!],
      async () => rows.filter((row) => row.repositoryId === 'r1'),
      vi.fn(),
    );
    expect(result).toEqual({ stackCounts: [3, 3, 2], openDrafts: 3, failedCounts: 0 });
  });
});
