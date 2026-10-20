import { describe, expect, it, vi } from 'vitest';
import { loadDashboardDraftCounts } from '@/server/application/dashboard-draft-counts';

const repositories = [
  { id: 'r1', headSha: 'a'.repeat(40) },
  { id: 'r2', headSha: 'b'.repeat(40) },
];
const stacks = [
  { id: 's1', rootPath: 'apps/one', repository: { id: 'r1', headSha: repositories[0]!.headSha } },
  { id: 's2', rootPath: 'apps/two', repository: { id: 'r2', headSha: repositories[1]!.headSha } },
];

describe('loadDashboardDraftCounts', () => {
  it('continues after a single repository fails and labels the total incomplete', async () => {
    const onFailure = vi.fn();
    const count = vi.fn(async (id: string, root: string) => {
      if (id === 'r2') throw new Error('repository unreadable');
      return root ? 2 : 4;
    });
    const result = await loadDashboardDraftCounts(stacks, repositories, count, onFailure);
    expect(result).toEqual({ stackCounts: [2, 0], openDrafts: null, failedCounts: 2 });
    expect(onFailure).toHaveBeenCalledTimes(2);
    expect(onFailure).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'repository', repositoryId: 'r2' }),
    );
    expect(count).toHaveBeenCalledWith('r1', '');
  });

  it('keeps an accurate repository total even if only one stack count fails', async () => {
    const onFailure = vi.fn();
    const result = await loadDashboardDraftCounts(
      stacks,
      repositories,
      async (id, root) => {
        if (id === 'r2' && root) throw new Error('stack scan failed');
        return root ? 1 : id === 'r1' ? 3 : 5;
      },
      onFailure,
    );
    expect(result).toEqual({ stackCounts: [1, 0], openDrafts: 8, failedCounts: 1 });
    expect(onFailure).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'stack', id: 's2', repositoryId: 'r2' }),
    );
  });

  it('does not try to read repositories without fetched heads', async () => {
    const count = vi.fn(async () => 99);
    const result = await loadDashboardDraftCounts(
      [{ id: 's', rootPath: 'x', repository: { id: 'r', headSha: null } }],
      [{ id: 'r', headSha: null }],
      count,
      vi.fn(),
    );
    expect(result).toEqual({ stackCounts: [0], openDrafts: 0, failedCounts: 0 });
    expect(count).not.toHaveBeenCalled();
  });
});
