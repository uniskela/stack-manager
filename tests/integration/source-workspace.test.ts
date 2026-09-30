import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as repoRoute from '@/app/api/workspaces/[workspaceId]/repositories/[repositoryId]/route';
import * as repoDraftsRoute from '@/app/api/workspaces/[workspaceId]/repositories/[repositoryId]/source/drafts/route';
import * as repoFilesRoute from '@/app/api/workspaces/[workspaceId]/repositories/[repositoryId]/source/files/route';
import * as repoTreeRoute from '@/app/api/workspaces/[workspaceId]/repositories/[repositoryId]/source/tree/route';
import * as addAllRoute from '@/app/api/workspaces/[workspaceId]/repositories/[repositoryId]/stacks/all/route';
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
    // Most tests exercise picking stacks by hand; auto-add has its own tests below.
    body: { gitProviderType: 'gitea', remoteUrl: REMOTE, auth: { type: 'none' }, autoAddStacks: false },
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
    for (const composePath of ['apps/liftlog/nope.yaml', 'apps/liftlog/config', 'apps/blinko/compose.yaml']) {
      const bad = await call(stackRoute.PATCH, {
        method: 'PATCH',
        cookie,
        params: { workspaceId, stackId },
        body: { composePath },
      });
      expect(bad.status, composePath).toBe(400);
    }
    const moved = await call(stackRoute.PATCH, {
      method: 'PATCH',
      cookie,
      params: { workspaceId, stackId },
      body: { composePath: 'apps/liftlog/config/app.json' },
    });
    expect(moved.json.stack.composePath).toBe('apps/liftlog/config/app.json');

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

describe('adding all stacks', () => {
  const suggestions = async () =>
    (await call(repoStacksRoute.GET, { cookie, params: { workspaceId, repositoryId } })).json.suggestions as {
      rootPath: string;
      existingStackId: string | null;
    }[];
  const addAll = () =>
    call(addAllRoute.POST, { method: 'POST', cookie, params: { workspaceId, repositoryId } });

  it('registers every Compose folder that is not a stack yet, once', async () => {
    const liftlogId = await liftlog();
    const res = await addAll();
    expect(res.status).toBe(200);
    expect(res.json.result).toEqual({ added: 2, existing: 1, failed: [] });
    const after = await suggestions();
    expect(after.every((s) => s.existingStackId)).toBe(true);
    expect(after.find((s) => s.rootPath === 'apps/liftlog')?.existingStackId).toBe(liftlogId);
    const list = await call(stacksRoute.GET, { cookie, params: { workspaceId } });
    expect(list.json.stacks.map((s: { slug: string }) => s.slug).sort()).toEqual([
      'acme-homelab',
      'blinko',
      'liftlog',
    ]);

    expect((await addAll()).json.result).toEqual({ added: 0, existing: 3, failed: [] });
  });

  it('counts folders registered by a concurrent add-all as existing, not failed', async () => {
    // Simulate another addAll winning the race: the moment this call inserts apps/blinko, a stack for the
    // same folder has just been registered by someone else.
    const stacks = h.container.repos.stacks;
    const insert = stacks.insert.bind(stacks);
    let raced = false;
    stacks.insert = async (stack) => {
      if (!raced && stack.rootPath === 'apps/blinko') {
        raced = true;
        await insert({ ...stack, id: `${stack.id}-other`, slug: `${stack.slug}-other` });
      }
      return insert(stack);
    };
    try {
      const res = await addAll();
      expect(res.json.result).toEqual({ added: 2, existing: 1, failed: [] });
    } finally {
      stacks.insert = insert;
    }
    expect((await suggestions()).every((s) => s.existingStackId)).toBe(true);
  });

  it('adds new stacks after each fetch when auto-add is on, and only then', async () => {
    server.commitFiles(REPO, 'main', {
      'apps/memos/compose.yaml': 'services:\n  memos:\n    image: memos:1\n',
    });
    await call(syncRoute.POST, { method: 'POST', cookie, params: { workspaceId, repositoryId } });
    await drainJobs();
    expect((await suggestions()).every((s) => s.existingStackId === null)).toBe(true);

    const patched = await call(repoRoute.PATCH, {
      method: 'PATCH',
      cookie,
      params: { workspaceId, repositoryId },
      body: { autoAddStacks: true },
    });
    expect(patched.json.repository.autoAddStacks).toBe(true);
    await call(syncRoute.POST, { method: 'POST', cookie, params: { workspaceId, repositoryId } });
    await drainJobs();
    const after = await suggestions();
    expect(after.map((s) => s.rootPath)).toContain('apps/memos');
    expect(after.every((s) => s.existingStackId)).toBe(true);

    const audit = await h.container.repos.audit.list({ workspaceId, limit: 50 });
    const auto = audit.filter((e) => e.action === 'stack.create' && e.actorUserId === null);
    expect(auto).toHaveLength(4);
    // Restore for other tests.
    server.commitFiles(REPO, 'main', { 'apps/memos/compose.yaml': null });
  });

  it('keeps going and reports a folder as failed when the recovery re-read fails', async () => {
    const stacks = h.container.repos.stacks;
    const insert = stacks.insert.bind(stacks);
    const list = stacks.listByRepository.bind(stacks);
    let broken = false;
    stacks.insert = async (stack) => {
      if (stack.rootPath === 'apps/blinko') {
        broken = true;
        throw new Error('disk I/O error');
      }
      return insert(stack);
    };
    stacks.listByRepository = async (...args) => {
      if (broken) {
        broken = false;
        throw new Error('database is locked');
      }
      return list(...args);
    };
    try {
      const res = await addAll();
      expect(res.json.result).toEqual({
        added: 2,
        existing: 0,
        failed: [{ rootPath: 'apps/blinko', message: 'Could not add this folder as a stack.' }],
      });
    } finally {
      stacks.insert = insert;
      stacks.listByRepository = list;
    }
  });

  it('registers every folder even when the suggestion list is capped', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 2001; i++) files[`s${String(i).padStart(4, '0')}/compose.yaml`] = 'services: {}\n';
    server.createRepo('acme/many.git', ['main']);
    server.commitFiles('acme/many.git', 'main', files);
    const many = await call(reposRoute.POST, {
      method: 'POST',
      cookie,
      params: { workspaceId },
      body: { gitProviderType: 'gitea', remoteUrl: 'https://git.test/acme/many.git', auth: { type: 'none' } },
    });
    await drainJobs();
    const id = many.json.repository.id;
    const listed = await call(repoStacksRoute.GET, { cookie, params: { workspaceId, repositoryId: id } });
    expect(listed.json.suggestions).toHaveLength(2000);
    // createRepo seeds a root compose.yaml as well.
    expect(listed.json.stacks.length).toBeGreaterThanOrEqual(2001);
    expect(listed.json.stacks.some((s: { rootPath: string }) => s.rootPath === 's2000')).toBe(true);
  }, 60_000);

  it('is on by default for new connections', async () => {
    server.createRepo('acme/second.git', ['main']);
    const other = await call(reposRoute.POST, {
      method: 'POST',
      cookie,
      params: { workspaceId },
      body: {
        gitProviderType: 'gitea',
        remoteUrl: 'https://git.test/acme/second.git',
        auth: { type: 'none' },
      },
    });
    expect(other.json.repository.autoAddStacks).toBe(true);
  });

  it('returns 409 before the first fetch and requires authentication', async () => {
    await h.container.repos.gitRepositories.update(repositoryId, { headSha: null, updatedAt: new Date() });
    expect((await addAll()).status).toBe(409);
    const anon = await call(addAllRoute.POST, { method: 'POST', params: { workspaceId, repositoryId } });
    expect(anon.status).toBe(401);
  });
});

describe('repository-wide files', () => {
  const ROOT_FILES = {
    'README.md': '# Homelab\n\nSee [setup](docs/setup.md).\n',
    'docs/setup.md': '# Setup\n',
    '.env.example': 'TZ=\n',
    '.env': 'TZ=Europe/Tallinn\nTOKEN=hunter2\n',
  };
  const refetch = async () => {
    await call(syncRoute.POST, { method: 'POST', cookie, params: { workspaceId, repositoryId } });
    await drainJobs();
  };
  const readRepoFile = (path: string, ws = workspaceId) =>
    call(repoFilesRoute.GET, {
      cookie,
      params: { workspaceId: ws, repositoryId },
      path: `/x?path=${encodeURIComponent(path)}`,
    });
  const saveRepoDraft = (body: Record<string, unknown>) =>
    call(repoDraftsRoute.PUT, { method: 'PUT', cookie, params: { workspaceId, repositoryId }, body });

  beforeEach(async () => {
    server.commitFiles(REPO, 'main', ROOT_FILES);
    await refetch();
  });
  afterEach(() => {
    server.commitFiles(REPO, 'main', Object.fromEntries(Object.keys(ROOT_FILES).map((k) => [k, null])));
  });

  it('lists files outside any stack, with secret files locked', async () => {
    const res = await call(repoTreeRoute.GET, { cookie, params: { workspaceId, repositoryId } });
    expect(res.status).toBe(200);
    const locked = Object.fromEntries(
      res.json.entries.map((e: { path: string; locked: string | null }) => [e.path, e.locked]),
    );
    expect(locked).toMatchObject({
      'README.md': null,
      'docs/setup.md': null,
      '.env.example': null,
      '.env': 'secret',
      'apps/liftlog/compose.yaml': null,
      'apps/liftlog/.env': 'secret',
    });
  });

  it('reads and drafts root docs and .env templates, never secret files', async () => {
    const readme = await readRepoFile('README.md');
    expect(readme.status).toBe(200);
    expect(readme.json.file).toMatchObject({ path: 'README.md', editable: true });
    expect(readme.json.file.content).toContain('# Homelab');

    const env = (await readRepoFile('.env.example')).json.file;
    const saved = await saveRepoDraft({
      path: '.env.example',
      content: 'TZ=\nPUID=\n',
      baseBlobSha: env.blobSha,
    });
    expect(saved.status).toBe(200);
    expect(saved.json.file.draft.content).toBe('TZ=\nPUID=\n');

    const secret = await readRepoFile('.env');
    expect(secret.json.file?.content ?? null).toBeNull();
    expect(secret.json.file?.locked).toBe('secret');
    expect((await saveRepoDraft({ path: '.env', content: 'TOKEN=x\n', baseBlobSha: null })).status).toBe(400);
    expect((await saveRepoDraft({ path: '../escape.md', content: 'x', baseBlobSha: null })).status).toBe(400);

    const changes = await call(repoDraftsRoute.GET, { cookie, params: { workspaceId, repositoryId } });
    expect(changes.json.changes.map((c: { path: string }) => c.path)).toEqual(['.env.example']);
    const discarded = await call(repoDraftsRoute.DELETE, {
      method: 'DELETE',
      cookie,
      params: { workspaceId, repositoryId },
      path: '/x?path=.env.example',
    });
    expect(discarded.status).toBe(200);
  });

  it('includes drafts made inside stacks and hides the repository from other workspaces', async () => {
    const stackId = await liftlog();
    const base = (await readFile(stackId, 'apps/liftlog/README.md')).json.file;
    await saveDraft(stackId, {
      path: 'apps/liftlog/README.md',
      content: '# LiftLog\n',
      baseBlobSha: base.blobSha,
    });
    const changes = await call(repoDraftsRoute.GET, { cookie, params: { workspaceId, repositoryId } });
    expect(changes.json.changes.map((c: { path: string }) => c.path)).toEqual(['apps/liftlog/README.md']);

    const other = (await call(workspaces.POST, { method: 'POST', body: { name: 'Other' }, cookie })).json
      .workspace.id;
    expect((await readRepoFile('README.md', other)).status).toBe(404);
    expect(
      (await call(repoTreeRoute.GET, { cookie, params: { workspaceId: other, repositoryId } })).status,
    ).toBe(404);
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
