import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHarness, type TestHarness } from '../support/container';
import * as reposRoute from '@/app/api/workspaces/[workspaceId]/repositories/route';
import * as credentialSecretRoute from '@/app/api/workspaces/[workspaceId]/credentials/[credentialId]/secret/route';
import * as wudConnection from '@/app/api/workspaces/[workspaceId]/image-updates/route';
import * as stackUpdates from '@/app/api/workspaces/[workspaceId]/stacks/[stackId]/image-updates/route';
import { sessionCookieName } from '@/server/http/cookies';
import { gitServerOverrides, startGitServer } from '../support/git-server';
import { call } from '../support/http';

const token = 'fixture-read-only-token';
let h: TestHarness | undefined;
afterEach(async () => h?.cleanup());

describe('WUD connections', () => {
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
      const [stack] = await stacks.list(workspaceId);
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
      const bind = await call(stackUpdates.PUT, {
        ...base,
        method: 'PUT',
        body: { watcher: 'local', project: 'wiki' },
      });
      expect(bind.status).toBe(200);
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
      expect((await imageUpdates.queue(workspaceId)).inventory[0]?.images).toEqual(expected);
      expect((await imageUpdates.queue(otherId)).inventory).toEqual([]);
    } finally {
      await git.close();
    }
  });
});
