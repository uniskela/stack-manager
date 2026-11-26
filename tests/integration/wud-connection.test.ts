import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHarness, type TestHarness } from '../support/container';
import * as reposRoute from '@/app/api/workspaces/[workspaceId]/repositories/route';
import * as credentialSecretRoute from '@/app/api/workspaces/[workspaceId]/credentials/[credentialId]/secret/route';
import * as wudConnection from '@/app/api/workspaces/[workspaceId]/image-updates/route';
import * as wudMappings from '@/app/api/workspaces/[workspaceId]/image-updates/mappings/route';
import * as stackUpdates from '@/app/api/workspaces/[workspaceId]/stacks/[stackId]/image-updates/route';
import { sessionCookieName } from '@/server/http/cookies';
import { gitServerOverrides, startGitServer } from '../support/git-server';
import { call } from '../support/http';
import { WUD_REFRESH_JOB } from '@/server/application/image-update-service';
import { AppError } from '@/server/domain/errors';

const token = 'fixture-read-only-token';
let h: TestHarness | undefined;
afterEach(async () => h?.cleanup());

describe('WUD connections', () => {
  it('queues independent due connections and reports each enqueue failure', async () => {
    h = await createHarness({ overrides: { wudClient: { read: vi.fn().mockResolvedValue([]) } } });
    const { workspaces, auth, imageUpdates, jobs } = h.container;
    const { user } = await auth.setupAdmin(
      { username: 'admin', password: 'a random test password' },
      { ip: null, userAgent: null },
    );
    const [first, second, third] = await Promise.all(
      ['First', 'Second', 'Third'].map(async (name) => {
        const { id } = await workspaces.create({ name }, user.id);
        const connection = await imageUpdates.configure(
          id,
          { baseUrl: 'https://wud.example', token, expectedRevision: null },
          user.id,
        );
        return { id, revision: connection.revision };
      }),
    );
    const enqueue = jobs.enqueue.bind(jobs);
    vi.spyOn(jobs, 'enqueue').mockImplementation(async (type, payload, options) => {
      if (payload.workspaceId !== second!.id) throw new Error('Failed to enqueue fixture refresh');
      return enqueue(type, payload, options);
    });
    h.clock.advance(15 * 60_000);
    const warn = vi.fn();
    imageUpdates.start({ warn });
    await imageUpdates.stop();

    expect(warn).toHaveBeenCalledTimes(2);
    for (const workspace of [first!, third!]) {
      expect(warn).toHaveBeenCalledWith('Could not schedule WUD refresh.', { workspaceId: workspace.id });
    }
    expect(await jobs.latestFor(`${WUD_REFRESH_JOB}:${second!.id}:${second!.revision}`)).toMatchObject({
      status: 'pending',
    });
  });

  it('tests a connection, keeps its token server-side and refreshes through a deduplicated job', async () => {
    const read = vi.fn().mockResolvedValue([]);
    h = await createHarness({ overrides: { wudClient: { read } } });
    const { workspaces, auth, imageUpdates, worker, jobs } = h.container;
    const actor = await auth.setupAdmin(
      {
        username: 'admin',
        password: 'a random test password',
      },
      { ip: '127.0.0.1', userAgent: null },
    );
    const workspace = await workspaces.create({ name: 'Homelab' }, actor.user.id);
    const connection = await imageUpdates.configure(
      workspace.id,
      {
        baseUrl: 'https://wud.example',
        token,
        expectedRevision: null,
      },
      actor.user.id,
    );
    expect(connection.baseUrl).toBe('https://wud.example');
    expect(JSON.stringify(connection)).not.toContain(token);
    expect(await imageUpdates.settings(workspace.id)).toMatchObject({ connection, refreshing: false });
    const [credential] = await h.container.credentials.list(workspace.id);
    const rotation = await call(credentialSecretRoute.PUT, {
      method: 'PUT',
      cookie: `${sessionCookieName(h.config)}=${actor.token}`,
      params: { workspaceId: workspace.id, credentialId: credential!.id },
      body: { secret: 'another-fixture-token' },
    });
    expect(rotation.status).toBe(409);
    const first = await imageUpdates.requestRefresh(workspace.id);
    const second = await imageUpdates.requestRefresh(workspace.id);
    expect(first.jobId).toBe(second.jobId);
    expect((await jobs.get(first.jobId))?.payload).toEqual({
      workspaceId: workspace.id,
      revision: connection.revision,
    });
    await worker.runOnce();
    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls[1]?.[1]).toBe(token);
    expect((await jobs.get(first.jobId))?.status).toBe('succeeded');
    expect(await imageUpdates.settings(workspace.id)).toMatchObject({ refreshing: false });
  });
});

describe('WUD image updates over authenticated routes', () => {
  it('uses committed Compose even with an existing draft and keeps workspaces isolated', async () => {
    const git = await startGitServer();
    try {
      git.createRepo('updates.git', ['main']);
      git.commitFiles('updates.git', 'main', {
        'cache/compose.yaml': 'services:\n  cache:\n    image: redis:7.2\n',
      });
      const time = new Date().toISOString();
      const read = vi.fn().mockResolvedValue([
        {
          watcher: 'local',
          project: 'wiki',
          service: 'app',
          repository: 'index.docker.io/library/nginx',
          installedTag: '1.27',
          installedDigest: null,
          checkedAt: time,
          available: true,
          failed: false,
          candidateTag: '1.28',
          digestOnly: false,
        },
        {
          watcher: 'local',
          project: 'cache-prod',
          service: 'cache',
          repository: 'index.docker.io/library/redis',
          installedTag: '7.2',
          installedDigest: null,
          checkedAt: time,
          available: false,
          failed: false,
          candidateTag: null,
          digestOnly: false,
        },
      ]);
      h = await createHarness({ overrides: { ...gitServerOverrides(git), wudClient: { read } } });
      const { auth, workspaces, worker, stacks, source, imageUpdates } = h.container;
      const { user, token: sessionToken } = await auth.setupAdmin(
        { username: 'admin', password: 'a random test password' },
        { ip: null, userAgent: null },
      );
      const cookie = sessionCookieName(h.config) + '=' + sessionToken;
      const workspaceId = (await workspaces.create({ name: 'Homelab' }, user.id)).id;
      const otherId = (await workspaces.create({ name: 'Other' }, user.id)).id;
      const request = { cookie, params: { workspaceId } };
      expect((await call(wudMappings.GET, request)).json.error.code).toBe('wud_not_connected');
      const repo = await call(reposRoute.POST, {
        ...request,
        method: 'POST',
        body: {
          gitProviderType: 'gitea',
          remoteUrl: 'https://git.test/updates.git',
          auth: { type: 'none' },
        },
      });
      expect(repo.status).toBe(201);
      await worker.runOnce();
      const allStacks = await stacks.list(workspaceId);
      const stack = allStacks.find((item) => item.composePath === 'compose.yaml');
      const cache = allStacks.find((item) => item.composePath === 'cache/compose.yaml')!;
      expect(stack?.composePath).toBe('compose.yaml');
      const stackId = stack!.id;
      const base = { cookie, params: { workspaceId, stackId } };
      expect((await call(stackUpdates.GET, { params: base.params })).status).toBe(401);
      expect(
        (await call(stackUpdates.GET, { cookie, params: { workspaceId: otherId, stackId } })).status,
      ).toBe(404);

      const connection = await call(wudConnection.PUT, {
        ...request,
        method: 'PUT',
        body: { baseUrl: 'https://wud.example', token, expectedRevision: null },
      });
      expect(connection.status).toBe(200);
      expect(connection.text).not.toContain(token);
      expect((await call(wudMappings.GET, { params: request.params })).status).toBe(401);
      const suggestions = await call(wudMappings.GET, request);
      expect(suggestions.status).toBe(200);
      expect(suggestions.json.suggestions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ stackId, watcher: 'local', project: 'wiki', matchedServices: ['app'] }),
          expect.objectContaining({
            stackId: cache.id,
            watcher: 'local',
            project: 'cache-prod',
            matchedServices: ['cache'],
          }),
        ]),
      );
      expect((await call(stackUpdates.GET, base)).json.binding).toBeNull();

      expect((await imageUpdates.queue(workspaceId)).needsSetup).toContainEqual(
        expect.objectContaining({ id: stackId, unmatched: [] }),
      );
      const mapping = { stackId, watcher: 'local', project: 'wiki' };
      const save = (mappings: (typeof mapping)[], confirmChoice?: true) =>
        call(wudMappings.POST, { ...request, method: 'POST', body: { mappings, confirmChoice } });
      const manual = { watcher: 'another-host', project: 'wiki' };
      expect((await call(stackUpdates.PUT, { ...base, method: 'PUT', body: manual })).status).toBe(200);
      expect(
        (await save([mapping, { stackId: cache.id, watcher: 'local', project: 'cache-prod' }])).json.results,
      ).toEqual([
        { stackId, status: 'changed' },
        { stackId: cache.id, status: 'saved' },
      ]);
      expect((await call(stackUpdates.GET, base)).json.binding).toEqual(manual);
      expect((await imageUpdates.queue(workspaceId)).needsSetup).toContainEqual(
        expect.objectContaining({ id: stackId, unmatched: ['app'] }),
      );

      expect((await call(stackUpdates.DELETE, { ...base, method: 'DELETE' })).status).toBe(200);
      const rows = await read();
      const alternate = { ...rows[0], watcher: 'alternate-host' };
      read.mockResolvedValueOnce([...rows, alternate]);
      await imageUpdates.requestRefresh(workspaceId);
      await worker.runOnce();
      const scoped = { ...request, path: `/api/test?stackId=${stackId}` };
      expect((await call(wudMappings.GET, scoped)).json.choices).toEqual([
        { watcher: 'local', project: 'wiki', matchedServices: ['app'] },
        { watcher: 'alternate-host', project: 'wiki', matchedServices: ['app'] },
      ]);
      expect((await save([mapping])).json.results).toEqual([{ stackId, status: 'changed' }]);
      expect((await save([{ ...mapping, watcher: 'unknown-host' }], true)).json.results).toEqual([
        { stackId, status: 'changed' },
      ]);
      vi.spyOn(h.container.audit, 'record').mockRejectedValueOnce(new Error('Fixture audit failure'));
      expect((await save([{ ...mapping, watcher: 'alternate-host' }], true)).json.results).toEqual([
        { stackId, status: 'saved' },
      ]);
      expect((await call(stackUpdates.GET, base)).json.binding).toEqual({
        watcher: 'alternate-host',
        project: 'wiki',
      });
      const file = await source.readFile(workspaceId, stack!.repository.id, '', 'compose.yaml');
      await source.saveDraft(
        workspaceId,
        stack!.repository.id,
        '',
        {
          path: 'compose.yaml',
          baseBlobSha: file.blobSha,
          content: 'services:\n  app:\n    image: nginx:2.0\n',
        },
        user.id,
      );

      const expected = [{ name: 'app', image: 'nginx:1.27', status: 'available', candidateTag: '1.28' }];
      expect((await call(stackUpdates.GET, base)).json.images).toEqual(expected);
      expect(
        (await imageUpdates.queue(workspaceId)).inventory.find((item) => item.stackId === stackId)?.images,
      ).toEqual(expected);
      expect((await imageUpdates.queue(otherId)).inventory).toEqual([]);
      h.clock.advance(30 * 60_000);
      const stale = await call(wudMappings.GET, request);
      expect(stale.status).toBe(409);
      expect(stale.json.error.code).toBe('wud_snapshot_stale');
      read.mockRejectedValueOnce(new AppError(502, 'wud_auth_failed', 'Fixture token refused.'));
      await imageUpdates.requestRefresh(workspaceId);
      await worker.runOnce();
      expect((await call(wudMappings.GET, request)).json.error.code).toBe('wud_auth_failed');
    } finally {
      await git.close();
    }
  });
});
