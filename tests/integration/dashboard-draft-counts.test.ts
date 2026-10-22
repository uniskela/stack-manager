import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadDashboardDraftCounts } from '@/server/application/dashboard-draft-counts';
import type { GitRepositoryConnection } from '@/server/domain/git-repository';
import { createHarness, type TestHarness } from '../support/container';

let h: TestHarness;
beforeEach(async () => {
  h = await createHarness();
  const now = h.clock.now();
  for (const id of ['w1', 'w2']) {
    await h.container.repos.workspaces.insert({
      id,
      name: id,
      slug: id,
      createdAt: now,
      updatedAt: now,
    });
  }
  for (const [id, workspaceId] of [
    ['r1', 'w1'],
    ['r2', 'w1'],
    ['r3', 'w2'],
  ] as const) {
    const repository: GitRepositoryConnection = {
      id,
      workspaceId,
      name: id,
      gitProviderType: 'gitea',
      remoteUrl: `https://git.example.com/test/${id}.git`,
      defaultBranch: 'main',
      credentialId: null,
      webhookCredentialId: null,
      localClonePath: `repos/${id}`,
      syncStatus: 'ready',
      lastSyncError: null,
      headSha: 'a'.repeat(40),
      lastFetchedAt: now,
      lastSyncAttemptAt: now,
      lastSyncFailedAt: null,
      lastHeadChangedAt: now,
      autoAddStacks: false,
      autoFetchEnabled: true,
      autoFetchIntervalMinutes: null,
      createdAt: now,
      updatedAt: now,
    };
    await h.container.repos.gitRepositories.insert(repository);
  }
});
afterEach(async () => h.cleanup());

describe('dashboard draft metadata query', () => {
  it('returns only paths for selected repositories, without reading draft contents', async () => {
    const now = h.clock.now();
    for (const [repositoryId, workspaceId, path] of [
      ['r1', 'w1', 'apps/wiki/compose.yaml'],
      ['r1', 'w1', 'apps/wiki-extra/compose.yaml'],
      ['r2', 'w1', 'apps/web/compose.yaml'],
      ['r3', 'w2', 'apps/private/compose.yaml'],
    ] as const) {
      await h.container.repos.drafts.upsert({
        id: `draft-${repositoryId}-${path}`,
        repositoryId,
        workspaceId,
        path,
        content: 'sensitive content that must not be loaded for counting',
        baseBlobSha: null,
        baseCommitSha: 'a'.repeat(40),
        createdByUserId: null,
        updatedByUserId: null,
        createdAt: now,
        updatedAt: now,
      });
    }

    const query = await h.container.source.listDraftPaths(['r1', 'r2']);
    // Pin the exact set: three in-scope rows and never the r3 draft.
    expect(query).toEqual(
      expect.arrayContaining([
        { repositoryId: 'r1', path: 'apps/wiki/compose.yaml' },
        { repositoryId: 'r1', path: 'apps/wiki-extra/compose.yaml' },
        { repositoryId: 'r2', path: 'apps/web/compose.yaml' },
      ]),
    );
    expect(query).toHaveLength(3);
    expect(query.some((row) => row.repositoryId === 'r3')).toBe(false);
    expect(JSON.stringify(query)).not.toContain('sensitive content');

    const counts = await loadDashboardDraftCounts(
      [
        { id: 'wiki', rootPath: 'apps/wiki', repository: { id: 'r1', headSha: 'a'.repeat(40) } },
        { id: 'web', rootPath: 'apps/web', repository: { id: 'r2', headSha: 'a'.repeat(40) } },
      ],
      [
        { id: 'r1', headSha: 'a'.repeat(40) },
        { id: 'r2', headSha: 'a'.repeat(40) },
      ],
      (ids) => h.container.source.listDraftPaths(ids),
      () => {
        throw new Error('The normal batch query should not fail.');
      },
    );
    expect(counts).toEqual({ stackCounts: [1, 1], openDrafts: 3, failedCounts: 0 });
    expect(await h.container.source.listDraftPaths([])).toEqual([]);
  });
});
