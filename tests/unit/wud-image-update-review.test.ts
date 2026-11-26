import { describe, expect, it, vi } from 'vitest';
import type { AuditService } from '@/server/application/audit-service';
import type { GitRepositoryService } from '@/server/application/git-repository-service';
import type { GitRepositoryConnectionRepository } from '@/server/application/ports';
import { WudImageUpdateReview } from '@/server/application/wud-image-update-review';
import type { GitRepositoryConnection } from '@/server/domain/git-repository';
import type {
  GiteaImageUpdatePull,
  GiteaImageUpdatePulls,
} from '@/server/providers/git/gitea-image-update-pulls';
import type { GitProvider } from '@/server/providers/git/types';

const workspaceId = 'workspace';
const repositoryId = 'repository';
const actorUserId = 'admin';
const token = 'fixture-token';
const headSha = 'a'.repeat(40);
const head = 'stack-manager/image-updates/' + 'b'.repeat(32);
const number = 12;
const challenge = { repositoryId, number, headSha };
const row: GiteaImageUpdatePull = {
  number,
  url: 'https://forge.example.test/org/stacks/pulls/12',
  head,
  headSha,
  base: 'main',
  title: 'chore: update container images',
  sameRepository: true,
  draft: false,
  mergeable: true,
};

function repository(patch: Partial<GitRepositoryConnection> = {}): GitRepositoryConnection {
  return {
    id: repositoryId,
    workspaceId,
    name: 'Stacks',
    gitProviderType: 'gitea',
    remoteUrl: 'https://forge.example.test/org/stacks.git',
    defaultBranch: 'main',
    credentialId: 'credential',
    webhookCredentialId: null,
    localClonePath: 'repositories/stacks',
    syncStatus: 'ready',
    lastSyncError: null,
    headSha: 'e'.repeat(40),
    lastFetchedAt: null,
    lastSyncAttemptAt: null,
    lastSyncFailedAt: null,
    lastHeadChangedAt: null,
    autoAddStacks: true,
    autoFetchEnabled: true,
    autoFetchIntervalMinutes: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...patch,
  };
}

function setup(connections = [repository()]) {
  const connectionStore = {
    findById: vi.fn<GitRepositoryConnectionRepository['findById']>(
      async (workspace, id) =>
        connections.find((item) => item.workspaceId === workspace && item.id === id) ?? null,
    ),
    list: vi.fn<GitRepositoryConnectionRepository['list']>(async (workspace) =>
      connections.filter((item) => item.workspaceId === workspace),
    ),
  };
  const withGitAccess: GitRepositoryService['withGitAccess'] = async (workspace, id, run) => {
    const conn = await connectionStore.findById(workspace, id);
    if (!conn) throw new Error('Missing connection');
    const provider = { descriptor: { type: conn.gitProviderType } } as GitProvider;
    return run(provider, {
      branch: conn.defaultBranch,
      cloneDir: conn.localClonePath,
      remoteUrl: conn.remoteUrl,
      auth: conn.credentialId ? { username: 'test-user', token } : null,
    });
  };
  const audit = { record: vi.fn<AuditService['record']>().mockResolvedValue(undefined) };
  const pulls = {
    list: vi.fn<GiteaImageUpdatePulls['list']>().mockResolvedValue([row]),
    get: vi.fn<GiteaImageUpdatePulls['get']>().mockResolvedValue(row),
    checks: vi.fn<GiteaImageUpdatePulls['checks']>().mockResolvedValue('success'),
    rebase: vi.fn<GiteaImageUpdatePulls['rebase']>().mockResolvedValue(undefined),
    merge: vi.fn<GiteaImageUpdatePulls['merge']>().mockResolvedValue(undefined),
  };
  return {
    service: new WudImageUpdateReview(connectionStore, { withGitAccess }, pulls, audit),
    pulls,
    audit,
  };
}

describe('WUD pull request review', () => {
  it('only lists same-repository app proposals against the tracked base', async () => {
    const { service, pulls } = setup([
      repository(),
      repository({ id: 'other-forge', gitProviderType: 'github' }),
      repository({ id: 'no-credentials', credentialId: null }),
    ]);
    pulls.list.mockResolvedValue([
      { ...row, title: token },
      { ...row, number: 13, sameRepository: false },
      { ...row, number: 14, sameRepository: undefined },
      { ...row, number: 15, base: 'other' },
      { ...row, number: 16, head: head + '-suffix' },
    ]);
    const result = await service.list(workspaceId);
    expect(result).toEqual({
      pulls: [
        {
          repositoryId,
          repositoryName: 'Stacks',
          number,
          url: row.url,
          headSha,
          title: '[REDACTED]',
          checkStatus: 'success',
          status: 'ready',
          ready: true,
        },
      ],
      unreadableRepositories: 0,
    });
    expect(pulls.list).toHaveBeenCalledOnce();
    expect(pulls.checks).toHaveBeenCalledOnce();
  });

  it('keeps other repositories reviewable when one forge read fails', async () => {
    const { service, pulls } = setup([repository({ id: 'offline' }), repository()]);
    pulls.list.mockRejectedValueOnce(new Error(token));
    await expect(service.list(workspaceId)).resolves.toMatchObject({
      pulls: [{ repositoryId, number, ready: true }],
      unreadableRepositories: 1,
    });
  });

  it('keeps a WIP title in review even when Gitea reports successful checks', async () => {
    const { service, pulls } = setup();
    pulls.list.mockResolvedValue([{ ...row, title: 'WIP: ' + row.title }]);
    await expect(service.list(workspaceId)).resolves.toMatchObject({
      pulls: [{ ready: false, status: 'review', checkStatus: 'success' }],
    });
  });

  it('rebases a conflicted proposal only while its confirmed head still matches', async () => {
    const { service, pulls, audit } = setup();
    const action = { ...challenge, action: 'rebase' as const };
    pulls.get.mockResolvedValue({ ...row, mergeable: false });
    await expect(service.update(workspaceId, actorUserId, action)).resolves.toEqual({ rebased: true });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'wud.pull_request_rebased' }),
    );
    pulls.get.mockResolvedValue({ ...row, headSha: 'f'.repeat(40) });
    await expect(service.update(workspaceId, actorUserId, action)).rejects.toMatchObject({ status: 409 });
    expect(pulls.rebase).toHaveBeenCalledOnce();
    expect(pulls.merge).not.toHaveBeenCalled();
  });

  it('merges and audits the exact confirmed PR after verifying its current state', async () => {
    const { service, pulls, audit } = setup();
    await expect(service.update(workspaceId, actorUserId, challenge)).resolves.toEqual({ merged: true });
    expect(pulls.get).toHaveBeenCalledWith(expect.objectContaining({ number }));
    expect(pulls.checks).toHaveBeenCalledWith(expect.objectContaining({ headSha }));
    expect(pulls.merge).toHaveBeenCalledWith(expect.objectContaining({ number, headSha }));
    expect(audit.record).toHaveBeenCalledWith({
      action: 'wud.pull_request_merged',
      workspaceId,
      actorUserId,
      entityId: repositoryId,
      entityType: 'repository',
      meta: { pullNumber: number },
    });
  });

  it.each([
    ['changed head', { headSha: 'c'.repeat(40) }],
    ['an untracked base', { base: 'other' }],
    ['a forked head', { sameRepository: false }],
    ['outside the app branch namespace', { head: 'other' }],
    ['a draft', { draft: true }],
    ['uncertain draft state', { draft: undefined }],
    ['an unmergeable PR', { mergeable: false }],
  ] as const)('refuses %s without a forge merge', async (_, changes) => {
    const { service, pulls, audit } = setup();
    pulls.get.mockResolvedValue({ ...row, ...changes });
    await expect(service.update(workspaceId, actorUserId, challenge)).rejects.toMatchObject({ status: 409 });
    expect(pulls.merge).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it.each(['failure', 'pending', 'missing'] as const)('blocks a merge with %s checks', async (state) => {
    const { service, pulls } = setup();
    pulls.checks.mockResolvedValue(state);
    await expect(service.update(workspaceId, actorUserId, challenge)).rejects.toMatchObject({ status: 409 });
    expect(pulls.merge).not.toHaveBeenCalled();
  });

  it('rejects a repository from another workspace before making forge requests', async () => {
    const { service, pulls } = setup();
    await expect(service.update('other-workspace', actorUserId, challenge)).rejects.toMatchObject({
      status: 404,
    });
    expect(pulls.get).not.toHaveBeenCalled();
  });
});
