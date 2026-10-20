import { describe, expect, it, vi } from 'vitest';
import { isRepositoryAutoFetchDue, RepositoryAutoFetch } from '@/server/application/repository-auto-fetch';
import type { GitRepositoryConnection } from '@/server/domain/git-repository';
import type { Job } from '@/server/domain/job';
import type { Workspace } from '@/server/domain/workspace';

const now = new Date('2026-10-20T08:00:00.000Z');
const minutesAgo = (n: number) => new Date(now.getTime() - n * 60_000);

function repository(overrides: Partial<GitRepositoryConnection> = {}): GitRepositoryConnection {
  return {
    id: 'repo-1',
    workspaceId: 'w1',
    name: 'infra',
    gitProviderType: 'gitea',
    remoteUrl: 'https://git.example.test/org/infra.git',
    defaultBranch: 'main',
    credentialId: null,
    webhookCredentialId: null,
    localClonePath: 'repos/repo-1',
    syncStatus: 'ready',
    lastSyncError: null,
    headSha: 'a'.repeat(40),
    lastFetchedAt: minutesAgo(16),
    autoAddStacks: true,
    createdAt: minutesAgo(90),
    updatedAt: minutesAgo(16),
    ...overrides,
  };
}

describe('isRepositoryAutoFetchDue', () => {
  const interval = 15 * 60_000;
  const due = (overrides: Partial<GitRepositoryConnection>) =>
    isRepositoryAutoFetchDue(repository(overrides), now, interval);

  it('fetches a ready repository after fifteen minutes, not earlier', () => {
    expect(due({ lastFetchedAt: minutesAgo(14) })).toBe(false);
    expect(due({ lastFetchedAt: minutesAgo(15) })).toBe(true);
  });

  it('waits from the last failure before trying again', () => {
    expect(due({ syncStatus: 'error', updatedAt: minutesAgo(3) })).toBe(false);
    expect(due({ syncStatus: 'error', updatedAt: minutesAgo(20) })).toBe(true);
  });

  it('does not compete with queued or running initial fetches', () => {
    expect(due({ syncStatus: 'pending' })).toBe(false);
    expect(due({ syncStatus: 'syncing' })).toBe(false);
  });

  it('uses connection creation as the due reference if no fetch completed', () => {
    expect(due({ lastFetchedAt: null, createdAt: minutesAgo(20) })).toBe(true);
  });
});

describe('RepositoryAutoFetch', () => {
  function make(overrides: Partial<GitRepositoryConnection> = {}) {
    const listWorkspaces = vi.fn(async () => [{ id: 'w1' } as Workspace]);
    const listRepositories = vi.fn(async () => [repository(overrides)]);
    const enqueue = vi.fn(async () => ({ created: true, job: {} as Job }));
    const warn = vi.fn();
    const debug = vi.fn();
    const scheduler = new RepositoryAutoFetch(
      { list: listWorkspaces },
      { list: listRepositories },
      { enqueue },
      { now: () => now },
      { warn, debug },
      15,
    );
    return { scheduler, enqueue, warn, listRepositories };
  }

  it('enqueues a reference-only durable sync job', async () => {
    const { scheduler, enqueue } = make();
    expect(await scheduler.runOnce()).toBe(1);
    expect(enqueue).toHaveBeenCalledWith(
      'repository_sync',
      { repositoryId: 'repo-1', requestedBy: null },
      { dedupeKey: 'repository_sync:repo-1' },
    );
  });

  it('skips repositories that are not due', async () => {
    const { scheduler, enqueue } = make({ lastFetchedAt: minutesAgo(1) });
    expect(await scheduler.runOnce()).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('handles deduplication without inflating the scheduled count', async () => {
    const { scheduler, enqueue } = make();
    enqueue.mockResolvedValue({ created: false, job: {} as Job });
    expect(await scheduler.runOnce()).toBe(0);
  });

  it('logs an enqueue failure without bringing down all polling', async () => {
    const { scheduler, enqueue, warn } = make();
    enqueue.mockRejectedValueOnce(new Error('database unavailable'));
    expect(await scheduler.runOnce()).toBe(0);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('does not allow an overlapping scan to enqueue twice', async () => {
    const { scheduler, enqueue } = make();
    const [first, second] = await Promise.all([scheduler.runOnce(), scheduler.runOnce()]);
    expect(first).toBe(1);
    expect(second).toBe(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});
