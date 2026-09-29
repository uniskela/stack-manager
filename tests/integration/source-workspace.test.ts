import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as repoStacksRoute from '@/app/api/workspaces/[workspaceId]/repositories/[repositoryId]/stacks/route';
import * as syncRoute from '@/app/api/workspaces/[workspaceId]/repositories/[repositoryId]/sync/route';
import * as reposRoute from '@/app/api/workspaces/[workspaceId]/repositories/route';
import * as draftsRoute from '@/app/api/workspaces/[workspaceId]/stacks/[stackId]/drafts/route';
import * as filesRoute from '@/app/api/workspaces/[workspaceId]/stacks/[stackId]/files/route';
import * as stackRoute from '@/app/api/workspaces/[workspaceId]/stacks/[stackId]/route';
import * as treeRoute from '@/app/api/workspaces/[workspaceId]/stacks/[stackId]/tree/route';
import * as stacksRoute from '@/app/api/workspaces/[workspaceId]/stacks/route';
import * as setup from '@/app/api/setup/route';
import * as workspaces from '@/app/api/workspaces/route';
import { createHarness, type TestHarness } from '../support/container';
import { gitServerOverrides, startGitServer, type GitServer } from '../support/git-server';
import { call, cookieFrom } from '../support/http';

const REPO = 'acme/homelab.git';
const REMOTE = `https://git.test/${REPO}`;
const LIFTLOG_COMPOSE =
  'services:\n  app:\n    image: ghcr.io/acme/liftlog:1.4\n    environment:\n      DB_URL: ${DB_URL}\n';

let server: GitServer;
let h: TestHarness;
let cookie: string;
let workspaceId: string;
let repositoryId: string;

beforeAll(async () => {
  server = await startGitServer();
  server.createRepo(REPO, ['main']);
  server.commitFiles(REPO, 'main', {
    'apps/liftlog/compose.yaml': LIFTLOG_COMPOSE,
    'apps/liftlog/README.md': '# LiftLog\n\nWorkout tracker.\n',
    'apps/liftlog/.env': 'DB_URL=postgres://user:hunter2@db/liftlog\n',
    'apps/liftlog/.env.example': 'DB_URL=\n',
    'apps/liftlog/config/app.json': '{"debug": false}\n',
    'apps/liftlog/link-out': { symlink: '../../../../etc/passwd' },
    'apps/blinko/docker-compose.yml': 'services:\n  blinko:\n    image: blinko:1\n',
    'apps/blinko/compose.yaml': 'services:\n  blinko:\n    image: blinko:2\n',
    'node_modules/pkg/compose.yaml': 'services: {}\n',
  });
});
afterAll(async () => server.close());

beforeEach(async () => {
  h = await createHarness({ overrides: gitServerOverrides(server) });
  cookie = cookieFrom(
    await call(setup.POST, {
      method: 'POST',
      body: { username: 'admin', password: 'correct horse battery staple' },
    }),
  );
  workspaceId = (await call(workspaces.POST, { method: 'POST', body: { name: 'Homelab' }, cookie })).json
    .workspace.id;
  const res = await call(reposRoute.POST, {
    method: 'POST',
    cookie,
    params: { workspaceId },
    body: { gitProviderType: 'gitea', remoteUrl: REMOTE, auth: { type: 'none' } },
  });
  expect(res.status).toBe(201);
  repositoryId = res.json.repository.id;
  await drainJobs();
});
afterEach(async () => h.cleanup());

async function drainJobs() {
  while (await h.container.worker.runOnce()) {
    /* run until idle */
  }
}

async function createStack(body: Record<string, unknown> = { rootPath: 'apps/liftlog' }) {
  return call(repoStacksRoute.POST, { method: 'POST', cookie, params: { workspaceId, repositoryId }, body });
}

async function liftlog(): Promise<string> {
  const res = await createStack();
  expect(res.status).toBe(201);
  return res.json.stack.id;
}

const readFile = (stackId: string, path: string) =>
  call(filesRoute.GET, {
    cookie,
    params: { workspaceId, stackId },
    path: `/x?path=${encodeURIComponent(path)}`,
  });

const saveDraft = (stackId: string, body: Record<string, unknown>) =>
  call(draftsRoute.PUT, { method: 'PUT', cookie, params: { workspaceId, stackId }, body });

describe('stack discovery', () => {
  it('suggests folders with a Compose file, preferring compose.yaml and skipping dependency folders', async () => {
    const res = await call(repoStacksRoute.GET, { cookie, params: { workspaceId, repositoryId } });
    expect(res.status).toBe(200);
    expect(res.json.suggestions).toEqual([
      { rootPath: '', composePath: 'compose.yaml', name: 'acme/homelab', existingStackId: null },
      {
        rootPath: 'apps/blinko',
        composePath: 'apps/blinko/compose.yaml',
        name: 'blinko',
        existingStackId: null,
      },
      {
        rootPath: 'apps/liftlog',
        composePath: 'apps/liftlog/compose.yaml',
        name: 'liftlog',
        existingStackId: null,
      },
    ]);
  });

  it('creates explicit stacks, detects the compose file and rejects duplicates and bad paths', async () => {
    const created = await createStack({ rootPath: 'apps/liftlog', name: 'LiftLog' });
    expect(created.json.stack).toMatchObject({
      name: 'LiftLog',
      slug: 'liftlog',
      rootPath: 'apps/liftlog',
      composePath: 'apps/liftlog/compose.yaml',
      repository: { id: repositoryId, defaultBranch: 'main' },
    });
    expect((await createStack({ rootPath: 'apps/liftlog/' })).status).toBe(409);
    for (const rootPath of ['../etc', 'apps/missing', '.git', 'apps/liftlog/config']) {
      expect((await createStack({ rootPath })).status, rootPath).toBe(400);
    }
    expect(
      (await createStack({ rootPath: 'apps/blinko', composePath: 'apps/liftlog/compose.yaml' })).status,
    ).toBe(400);

    const list = await call(stacksRoute.GET, { cookie, params: { workspaceId } });
    expect(list.json.stacks.map((s: { name: string }) => s.name)).toEqual(['LiftLog']);
    const again = await call(repoStacksRoute.GET, { cookie, params: { workspaceId, repositoryId } });
    expect(
      again.json.suggestions.find((s: { rootPath: string }) => s.rootPath === 'apps/liftlog').existingStackId,
    ).toBe(created.json.stack.id);
  });

  it('renames and deletes stacks; other workspaces cannot see them', async () => {
    const stackId = await liftlog();
    const patched = await call(stackRoute.PATCH, {
      method: 'PATCH',
      cookie,
      params: { workspaceId, stackId },
      body: { name: 'Lift Log' },
    });
    expect(patched.json.stack.name).toBe('Lift Log');

    const other = (await call(workspaces.POST, { method: 'POST', body: { name: 'Other' }, cookie })).json
      .workspace.id;
    expect((await call(stackRoute.GET, { cookie, params: { workspaceId: other, stackId } })).status).toBe(
      404,
    );
    expect((await readFile(stackId, 'apps/liftlog/compose.yaml')).status).toBe(200);
    expect(
      (
        await call(filesRoute.GET, {
          cookie,
          params: { workspaceId: other, stackId },
          path: '/x?path=apps/liftlog/compose.yaml',
        })
      ).status,
    ).toBe(404);

    expect(
      (await call(stackRoute.DELETE, { method: 'DELETE', cookie, params: { workspaceId, stackId } })).status,
    ).toBe(200);
    expect((await call(stackRoute.GET, { cookie, params: { workspaceId, stackId } })).status).toBe(404);
  });

  it('requires authentication', async () => {
    expect((await call(stacksRoute.GET, { params: { workspaceId } })).status).toBe(401);
  });
});

describe('source files', () => {
  it('lists the stack tree with secret, symlink and draft markers', async () => {
    const stackId = await liftlog();
    const res = await call(treeRoute.GET, { cookie, params: { workspaceId, stackId } });
    expect(res.status).toBe(200);
    const byPath = Object.fromEntries(
      res.json.entries.map((e: { path: string; locked: string | null }) => [e.path, e.locked]),
    );
    expect(byPath).toEqual({
      'apps/liftlog/.env': 'secret',
      'apps/liftlog/.env.example': null,
      'apps/liftlog/README.md': null,
      'apps/liftlog/compose.yaml': null,
      'apps/liftlog/config/app.json': null,
      'apps/liftlog/link-out': 'symlink',
    });
    expect(res.json.commitSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('returns committed content, never secret contents, and refuses paths outside the stack', async () => {
    const stackId = await liftlog();
    const compose = await readFile(stackId, 'apps/liftlog/compose.yaml');
    expect(compose.json.file).toMatchObject({
      language: 'yaml',
      content: LIFTLOG_COMPOSE,
      editable: true,
      locked: null,
      draft: null,
    });

    const secret = await readFile(stackId, 'apps/liftlog/.env');
    expect(secret.json.file).toMatchObject({ locked: 'secret', content: null, editable: false });
    expect(secret.text).not.toContain('hunter2');

    const link = await readFile(stackId, 'apps/liftlog/link-out');
    expect(link.json.file).toMatchObject({ locked: 'symlink', content: null });

    for (const path of [
      'apps/blinko/compose.yaml',
      '../../etc/passwd',
      '/etc/passwd',
      'apps/liftlog/../blinko/compose.yaml',
    ]) {
      expect((await readFile(stackId, path)).status, path).toBe(400);
    }
    expect((await readFile(stackId, 'apps/liftlog/nope.yaml')).status).toBe(404);
  });
});

describe('drafts', () => {
  it('saves, reads back, lists and discards a draft; identical content clears it', async () => {
    const stackId = await liftlog();
    const base = (await readFile(stackId, 'apps/liftlog/compose.yaml')).json.file;
    const edited = LIFTLOG_COMPOSE.replace('1.4', '1.5');

    const saved = await saveDraft(stackId, {
      path: 'apps/liftlog/compose.yaml',
      content: edited,
      baseBlobSha: base.blobSha,
    });
    expect(saved.status).toBe(200);
    expect(saved.json.file.draft).toMatchObject({
      content: edited,
      baseBlobSha: base.blobSha,
      outdated: false,
    });
    expect((await readFile(stackId, 'apps/liftlog/compose.yaml')).json.file.draft.content).toBe(edited);

    const changes = await call(draftsRoute.GET, { cookie, params: { workspaceId, stackId } });
    expect(changes.json.changes).toEqual([
      expect.objectContaining({
        path: 'apps/liftlog/compose.yaml',
        isNew: false,
        before: LIFTLOG_COMPOSE,
        after: edited,
      }),
    ]);
    const tree = await call(treeRoute.GET, { cookie, params: { workspaceId, stackId } });
    expect(
      tree.json.entries.find((e: { path: string }) => e.path === 'apps/liftlog/compose.yaml').draft,
    ).toBe('modified');

    // Saving the committed content again is "no change".
    const reverted = await saveDraft(stackId, {
      path: 'apps/liftlog/compose.yaml',
      content: LIFTLOG_COMPOSE,
      baseBlobSha: base.blobSha,
    });
    expect(reverted.json.file.draft).toBeNull();

    await saveDraft(stackId, {
      path: 'apps/liftlog/compose.yaml',
      content: edited,
      baseBlobSha: base.blobSha,
    });
    const discarded = await call(draftsRoute.DELETE, {
      method: 'DELETE',
      cookie,
      params: { workspaceId, stackId },
      path: '/x?path=apps/liftlog/compose.yaml',
    });
    expect(discarded.json.file).toMatchObject({ draft: null, content: LIFTLOG_COMPOSE });

    const events = await h.container.audit.list({ workspaceId });
    const draftEvents = events.filter((e) => e.action.startsWith('draft.'));
    expect(draftEvents.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(draftEvents)).not.toContain('1.5');
  });

  it('creates new files as drafts and shows them in the tree', async () => {
    const stackId = await liftlog();
    const res = await saveDraft(stackId, {
      path: 'apps/liftlog/docs/runbook.md',
      content: '# Runbook\n',
      baseBlobSha: null,
    });
    expect(res.status).toBe(200);
    expect(res.json.file).toMatchObject({ blobSha: null, content: null, draft: { outdated: false } });
    const tree = await call(treeRoute.GET, { cookie, params: { workspaceId, stackId } });
    expect(tree.json.entries).toContainEqual(
      expect.objectContaining({ path: 'apps/liftlog/docs/runbook.md', draft: 'new' }),
    );

    const discarded = await call(draftsRoute.DELETE, {
      method: 'DELETE',
      cookie,
      params: { workspaceId, stackId },
      path: '/x?path=apps/liftlog/docs/runbook.md',
    });
    expect(discarded.json.file).toBeNull();
  });

  it('refuses secret files, symlinks, directories, paths outside the stack and oversized content', async () => {
    const stackId = await liftlog();
    const cases: Array<[Record<string, unknown>, number]> = [
      [{ path: 'apps/liftlog/.env', content: 'X=1', baseBlobSha: null }, 400],
      [{ path: 'apps/liftlog/.env.production', content: 'X=1', baseBlobSha: null }, 400],
      [{ path: 'apps/liftlog/secrets/db.txt', content: 'x', baseBlobSha: null }, 400],
      [{ path: 'apps/liftlog/link-out', content: 'x', baseBlobSha: null }, 400],
      [{ path: 'apps/liftlog/config', content: 'x', baseBlobSha: null }, 400],
      [{ path: 'apps/liftlog/compose.yaml/x', content: 'x', baseBlobSha: null }, 400],
      [{ path: 'apps/blinko/compose.yaml', content: 'x', baseBlobSha: null }, 400],
      [{ path: 'apps/liftlog/../blinko/x.yaml', content: 'x', baseBlobSha: null }, 400],
      [{ path: 'apps/liftlog/.git/config', content: 'x', baseBlobSha: null }, 400],
      [{ path: 'apps/liftlog/a.txt', content: 'a\u0000b', baseBlobSha: null }, 400],
      [{ path: 'apps/liftlog/a.txt', content: 'x', baseBlobSha: 'not-a-sha' }, 400],
      [{ path: 'apps/liftlog/big.txt', content: 'é'.repeat(600_000), baseBlobSha: null }, 400],
    ];
    for (const [body, status] of cases) {
      expect((await saveDraft(stackId, body)).status, String(body.path)).toBe(status);
    }
    // The route body cap rejects absurd payloads before parsing.
    const huge = await call(draftsRoute.PUT, {
      method: 'PUT',
      cookie,
      params: { workspaceId, stackId },
      body: JSON.stringify({
        path: 'apps/liftlog/a.txt',
        content: 'x'.repeat(4 * 1024 * 1024),
        baseBlobSha: null,
      }),
    });
    expect(huge.status).toBe(413);
  });

  it('marks a draft outdated when the file changes upstream', async () => {
    const stackId = await liftlog();
    const base = (await readFile(stackId, 'apps/liftlog/compose.yaml')).json.file;
    await saveDraft(stackId, {
      path: 'apps/liftlog/compose.yaml',
      content: LIFTLOG_COMPOSE + '# local\n',
      baseBlobSha: base.blobSha,
    });
    server.commitFiles(REPO, 'main', { 'apps/liftlog/compose.yaml': LIFTLOG_COMPOSE + '# upstream\n' });
    await call(syncRoute.POST, { method: 'POST', cookie, params: { workspaceId, repositoryId } });
    await drainJobs();

    const after = (await readFile(stackId, 'apps/liftlog/compose.yaml')).json.file;
    expect(after.content).toContain('# upstream');
    expect(after.draft).toMatchObject({ outdated: true, baseBlobSha: base.blobSha });
    // Restore for other tests.
    server.commitFiles(REPO, 'main', { 'apps/liftlog/compose.yaml': LIFTLOG_COMPOSE });
  });

  it('returns 409 until the repository has been fetched', async () => {
    const stackId = await liftlog();
    await h.container.repos.gitRepositories.update(repositoryId, { headSha: null, updatedAt: new Date() });
    expect((await readFile(stackId, 'apps/liftlog/compose.yaml')).status).toBe(409);
  });
});
