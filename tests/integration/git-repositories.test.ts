import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as repoRoute from '@/app/api/workspaces/[workspaceId]/repositories/[repositoryId]/route';
import * as syncRoute from '@/app/api/workspaces/[workspaceId]/repositories/[repositoryId]/sync/route';
import * as savedTest from '@/app/api/workspaces/[workspaceId]/repositories/[repositoryId]/test/route';
import * as reposRoute from '@/app/api/workspaces/[workspaceId]/repositories/route';
import * as testRoute from '@/app/api/workspaces/[workspaceId]/repositories/test/route';
import * as setup from '@/app/api/setup/route';
import * as workspaces from '@/app/api/workspaces/route';
import { openSqlite } from '@/server/persistence/sqlite/database';
import { GitCli } from '@/server/providers/git/git-cli';
import { createHarness, type TestHarness } from '../support/container';
import { gitServerOverrides, startGitServer, type GitServer } from '../support/git-server';
import { call, cookieFrom } from '../support/http';

const TOKEN = 'gitea_token_' + 'f00dfacecafe1234567890abcdef';
const REMOTE = 'https://git.test/acme/stacks.git';

let server: GitServer;
let h: TestHarness;
let cookie: string;
let workspaceId: string;

beforeAll(async () => {
  server = await startGitServer({ username: 'deploy-bot', token: TOKEN });
  server.createRepo('acme/stacks.git', ['main', 'staging']);
  server.createRepo('acme/public.git', ['trunk']);
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
  server.authHeaders.length = 0;
});
afterEach(async () => h.cleanup());

const tokenAuth = (token = TOKEN) => ({ type: 'token', token, username: 'deploy-bot' });

async function connect(body: Record<string, unknown> = {}) {
  return call(reposRoute.POST, {
    method: 'POST',
    cookie,
    params: { workspaceId },
    body: { gitProviderType: 'gitea', remoteUrl: REMOTE, auth: tokenAuth(), ...body },
  });
}

async function drainJobs() {
  while (await h.container.worker.runOnce()) {
    /* run until idle */
  }
}

function allTextOnDisk(dir: string): string {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && fs.statSync(p).size < 5_000_000) out.push(fs.readFileSync(p).toString('latin1'));
    }
  };
  walk(dir);
  return out.join('\n');
}

describe('repository connection test', () => {
  it('succeeds with a valid token and reports default branch and branches', async () => {
    const res = await call(testRoute.POST, {
      method: 'POST',
      cookie,
      params: { workspaceId },
      body: { gitProviderType: 'gitea', remoteUrl: REMOTE, auth: tokenAuth() },
    });
    expect(res.status).toBe(200);
    expect(res.json.result).toEqual({
      ok: true,
      defaultBranch: 'main',
      branches: ['main', 'staging'],
      branchCount: 2,
    });
    // Credentials travelled as an Authorization header, never in the URL.
    expect(server.authHeaders.some((a) => a.startsWith('Basic '))).toBe(true);
    expect(server.requestUrls.join('\n')).not.toContain(TOKEN);
  });

  it('reports an auth failure with a bad token, without echoing it', async () => {
    const res = await call(testRoute.POST, {
      method: 'POST',
      cookie,
      params: { workspaceId },
      body: { gitProviderType: 'gitea', remoteUrl: REMOTE, auth: tokenAuth('wrong-token-value-123456') },
    });
    expect(res.json.result).toMatchObject({ ok: false, reason: 'auth' });
    expect(res.text).not.toContain('wrong-token-value-123456');
  });

  it('rejects insecure, credential-bearing and local remotes before any network call', async () => {
    for (const remoteUrl of [
      'http://git.test/acme/stacks.git',
      `https://bot:${TOKEN}@git.test/acme/stacks.git`,
      'git@git.test:acme/stacks.git',
      'file:///etc',
      'https://[::ffff:127.0.0.1]/acme/stacks.git',
      'https://[::ffff:a9fe:a9fe]/acme/stacks.git',
    ]) {
      const res = await call(testRoute.POST, {
        method: 'POST',
        cookie,
        params: { workspaceId },
        body: { gitProviderType: 'gitea', remoteUrl, auth: { type: 'none' } },
      });
      expect(res.status, remoteUrl).toBe(400);
      expect(res.text).not.toContain(TOKEN);
    }
    const local = await call(testRoute.POST, {
      method: 'POST',
      cookie,
      params: { workspaceId },
      body: {
        gitProviderType: 'gitea',
        remoteUrl: 'https://localhost/acme/stacks.git',
        auth: { type: 'none' },
      },
    });
    expect(local.status).toBe(400);
    expect(server.authHeaders).toHaveLength(0);
  });

  it('rejects unknown provider types (core does not assume GitHub)', async () => {
    const res = await connect({ gitProviderType: 'bitbucket' });
    expect(res.status).toBe(400);
  });
});

describe('repository connection lifecycle', () => {
  it('creates the connection, encrypts the token, clones under the data dir and lists branches', async () => {
    const res = await connect();
    expect(res.status).toBe(201);
    const repo = res.json.repository;
    expect(repo).toMatchObject({
      name: 'acme/stacks',
      gitProviderType: 'gitea',
      providerName: 'Gitea',
      defaultBranch: 'main',
      syncStatus: 'pending',
      remoteUrl: REMOTE,
    });
    expect(repo.credential).toMatchObject({
      kind: 'git',
      providerType: 'gitea',
      hint: '••••cdef',
      meta: { username: 'deploy-bot' },
    });
    expect(res.text).not.toContain(TOKEN);

    await drainJobs();

    const detail = await call(repoRoute.GET, { cookie, params: { workspaceId, repositoryId: repo.id } });
    expect(detail.json.repository).toMatchObject({ syncStatus: 'ready', lastSyncError: null });
    expect(detail.json.repository.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(detail.json.repository.lastFetchedAt).not.toBeNull();
    expect(detail.json.branches).toEqual(['main', 'staging']);

    const cloneDir = path.join(h.dataDir, 'repos', repo.id);
    expect(fs.existsSync(path.join(cloneDir, 'compose.yaml'))).toBe(true);
    // No stray temp clones.
    expect(fs.readdirSync(path.join(h.dataDir, 'repos')).filter((n) => n.startsWith('.tmp'))).toEqual([]);

    // The token never lands on disk: not in .git/config, not in the DB, not in any file under the data dir.
    const gitConfig = fs.readFileSync(path.join(cloneDir, '.git', 'config'), 'utf8');
    expect(gitConfig).toContain('url = https://git.test/acme/stacks.git');
    expect(gitConfig).not.toMatch(/extraheader|Authorization/i);
    expect(allTextOnDisk(h.dataDir)).not.toContain(TOKEN);
    expect(allTextOnDisk(h.dataDir)).not.toContain(Buffer.from(`deploy-bot:${TOKEN}`).toString('base64'));

    // …nor in logs or audit.
    const audit = JSON.stringify(await h.container.audit.list({ workspaceId, limit: 100 }));
    expect(audit).toContain('repository.sync');
    expect(audit + h.logs.join('\n')).not.toContain(TOKEN);
  });

  it('fetches new commits on sync', async () => {
    const repo = (await connect()).json.repository;
    await drainJobs();
    const before = (await call(repoRoute.GET, { cookie, params: { workspaceId, repositoryId: repo.id } }))
      .json.repository.headSha;
    const newSha = server.commit('acme/stacks.git', 'main', 'README.md', `# Stacks ${Date.now()}\n`);
    const sync = await call(syncRoute.POST, {
      method: 'POST',
      cookie,
      params: { workspaceId, repositoryId: repo.id },
    });
    expect(sync.status).toBe(200);
    // Duplicate sync requests while one is pending are deduplicated.
    await call(syncRoute.POST, { method: 'POST', cookie, params: { workspaceId, repositoryId: repo.id } });
    await drainJobs();
    const after = (await call(repoRoute.GET, { cookie, params: { workspaceId, repositoryId: repo.id } })).json
      .repository;
    expect(after.headSha).toBe(newSha);
    expect(after.headSha).not.toBe(before);
  });

  it('connects public repositories without a credential and detects the default branch', async () => {
    await h.cleanup();
    const publicServer = await startGitServer();
    publicServer.createRepo('acme/public.git', ['trunk', 'dev']);
    h = await createHarness({ overrides: gitServerOverrides(publicServer) });
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
      body: {
        gitProviderType: 'forgejo',
        remoteUrl: 'https://git.test/acme/public.git',
        auth: { type: 'none' },
      },
    });
    expect(res.status).toBe(201);
    expect(res.json.repository).toMatchObject({
      defaultBranch: 'trunk',
      credential: null,
      providerName: 'Forgejo',
    });
    await drainJobs();
    expect((await h.container.repositories.get(workspaceId, res.json.repository.id)).syncStatus).toBe(
      'ready',
    );
    expect(publicServer.authHeaders).toHaveLength(0);
    await publicServer.close();
  });

  it('refuses to save a connection that fails the access test, and rejects unknown branches and duplicates', async () => {
    const bad = await connect({ auth: tokenAuth('nope-nope-nope-nope') });
    expect(bad.status).toBe(400);
    expect(await h.container.credentials.list(workspaceId)).toHaveLength(0);
    const badBranch = await connect({ defaultBranch: 'does-not-exist' });
    expect(badBranch.status).toBe(400);
    const flagBranch = await connect({ defaultBranch: '--upload-pack=touch /tmp/pwned' });
    expect(flagBranch.status).toBe(400);
    expect((await connect()).status).toBe(201);
    expect((await connect()).status).toBe(409);
  });

  it('re-tests a saved connection with the stored credential and records the result', async () => {
    const repo = (await connect()).json.repository;
    const res = await call(savedTest.POST, {
      method: 'POST',
      cookie,
      params: { workspaceId, repositoryId: repo.id },
    });
    expect(res.json.result.ok).toBe(true);
    const cred = await h.container.credentials.get(workspaceId, repo.credential.id);
    expect(cred.lastTestStatus).toBe('ok');
  });

  it('marks sync failed (permanently) when the stored token is revoked', async () => {
    const repo = (await connect()).json.repository;
    await h.container.credentials.replaceSecret(
      workspaceId,
      repo.credential.id,
      'revoked-token-value-0000',
      'system',
    );
    await drainJobs();
    const view = await h.container.repositories.get(workspaceId, repo.id);
    expect(view.syncStatus).toBe('error');
    expect(view.lastSyncError).toMatch(/Authentication failed/);
    expect(view.sync?.status).toBe('failed');
    expect(JSON.stringify(view)).not.toContain('revoked-token-value-0000');
  });

  it('blocks clone paths that escape the repositories directory', async () => {
    const repo = (await connect()).json.repository;
    const outside = path.join(h.dataDir, '..', `escape-${repo.id}`);
    for (const evil of [
      '../escape',
      `repos/../../escape-${repo.id}`,
      '/tmp/evil',
      'stack-manager.sqlite',
      'repos',
    ]) {
      const db = openSqlite(path.join(h.dataDir, 'stack-manager.sqlite'));
      db.db.$client
        .prepare('UPDATE git_repository_connections SET local_clone_path = ? WHERE id = ?')
        .run(evil, repo.id);
      db.close();
      await h.container.repositories.sync(repo.id).then(
        () => expect.unreachable(`sync should reject ${evil}`),
        (error: Error) => expect(error.message).toMatch(/escapes|outside/i),
      );
    }
    expect(fs.existsSync(outside)).toBe(false);
    expect(fs.existsSync(path.join(h.dataDir, 'stack-manager.sqlite'))).toBe(true);
  });

  it('refuses to delete while a sync is running', async () => {
    const repo = (await connect()).json.repository;
    const claimed = await h.container.repos.jobs.claimNext('busy-worker', h.clock.now(), 60_000, [
      'repository_sync',
    ]);
    expect(claimed?.payload.repositoryId).toBe(repo.id);
    const res = await call(repoRoute.DELETE, {
      method: 'DELETE',
      cookie,
      params: { workspaceId, repositoryId: repo.id },
    });
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe('sync_in_progress');
    await h.container.repos.jobs.markSucceeded(claimed!.id, 'busy-worker', h.clock.now());
    expect(
      (
        await call(repoRoute.DELETE, {
          method: 'DELETE',
          cookie,
          params: { workspaceId, repositoryId: repo.id },
        })
      ).status,
    ).toBe(200);
  });

  it('removes the clone when the connection is deleted mid-sync', async () => {
    const repo = (await connect()).json.repository;
    const provider = h.container.gitProviders.get('gitea');
    const original = provider.syncClone.bind(provider);
    provider.syncClone = async (input) => {
      const result = await original(input);
      await h.container.repos.gitRepositories.delete(repo.id); // deletion lands while git was running
      return result;
    };
    try {
      await expect(h.container.repositories.sync(repo.id)).rejects.toThrow(/deleted during sync/);
    } finally {
      provider.syncClone = original;
    }
    expect(fs.existsSync(path.join(h.dataDir, 'repos', repo.id))).toBe(false);
  });

  it('delete removes the connection and its clone, keeps the credential', async () => {
    const repo = (await connect()).json.repository;
    await drainJobs();
    const cloneDir = path.join(h.dataDir, 'repos', repo.id);
    expect(fs.existsSync(cloneDir)).toBe(true);
    const res = await call(repoRoute.DELETE, {
      method: 'DELETE',
      cookie,
      params: { workspaceId, repositoryId: repo.id },
    });
    expect(res.status).toBe(200);
    expect(fs.existsSync(cloneDir)).toBe(false);
    expect(
      (await call(repoRoute.GET, { cookie, params: { workspaceId, repositoryId: repo.id } })).status,
    ).toBe(404);
    expect(await h.container.credentials.list(workspaceId)).toHaveLength(1);
  });

  it('production git settings refuse non-HTTPS transports', async () => {
    const git = new GitCli({ homeDir: path.join(h.dataDir, 'git-home'), allowedProtocols: ['https'] });
    await expect(git.run(['ls-remote', '--', `${server.baseUrl}acme/stacks.git`])).rejects.toThrow();
    await expect(git.run(['ls-remote', '--', `file://${server.root}/acme/stacks.git`])).rejects.toThrow();
    await expect(git.run(['ls-remote', '--', 'ext::sh -c id'])).rejects.toThrow();
    expect(server.authHeaders).toHaveLength(0);
  });
});
