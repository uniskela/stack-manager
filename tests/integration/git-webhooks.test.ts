import { createHash, createHmac, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as ingress from '@/app/api/webhooks/git/[workspaceId]/[repositoryId]/route';
import * as settings from '@/app/api/workspaces/[workspaceId]/repositories/[repositoryId]/webhook/route';
import * as testConnection from '@/app/api/workspaces/[workspaceId]/repositories/test/route';
import * as connectRepository from '@/app/api/workspaces/[workspaceId]/repositories/route';
import * as setup from '@/app/api/setup/route';
import * as workspaces from '@/app/api/workspaces/route';
import { setContainer } from '@/server/container';
import { openSqlite } from '@/server/persistence/sqlite/database';
import { createHarness, type TestHarness } from '../support/container';
import { gitServerOverrides, startGitServer } from '../support/git-server';
import { call, cookieFrom } from '../support/http';

// Synthetic signing material only. Provider payload shapes follow the official push examples.
const SECRET = 'webhook-test-abcdef0123456789ABCDEF9876543210';
const ROTATED = 'rotated-test-9876543210ABCDEFabcdef0123456789';
const providers = ['github', 'gitea', 'forgejo'] as const;
let h: TestHarness;
let cookie: string;
let workspaceId: string;
let repositoryId: string;
let actor: string;

beforeEach(async () => {
  h = await createHarness();
  const response = await call(setup.POST, {
    method: 'POST',
    body: { username: 'admin', password: 'correct horse battery staple' },
  });
  cookie = cookieFrom(response);
  actor = response.json.user.id;
  workspaceId = (await call(workspaces.POST, { method: 'POST', cookie, body: { name: 'Home' } })).json
    .workspace.id;
  repositoryId = randomUUID();
  await h.container.repos.gitRepositories.insert({
    id: repositoryId,
    workspaceId,
    name: 'Infra',
    gitProviderType: 'github',
    remoteUrl: 'https://github.com/acme/infra.git',
    defaultBranch: 'main',
    credentialId: null,
    webhookCredentialId: null,
    localClonePath: `repos/${repositoryId}`,
    syncStatus: 'ready',
    lastSyncError: null,
    headSha: null,
    lastFetchedAt: null,
    lastSyncAttemptAt: null,
    lastSyncFailedAt: null,
    lastHeadChangedAt: null,
    autoAddStacks: true,
    autoFetchEnabled: true,
    autoFetchIntervalMinutes: null,
    createdAt: h.clock.now(),
    updatedAt: h.clock.now(),
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await h.cleanup();
});
const params = () => ({ workspaceId, repositoryId });
async function configure(secret = SECRET) {
  return call(settings.PUT, { method: 'PUT', cookie, params: params(), body: { secret } });
}
function payload(provider = 'github'): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(`tests/fixtures/webhooks/${provider}-push.json`, 'utf8'));
}
function headers(provider: string, body: string, id: string = randomUUID(), secret = SECRET) {
  const digest = createHmac('sha256', secret).update(body).digest('hex');
  return {
    'content-type': 'application/json',
    [`x-${provider}-event`]: 'push',
    [`x-${provider}-delivery`]: id,
    [provider === 'github' ? 'x-hub-signature-256' : `x-${provider}-signature`]:
      provider === 'github' ? `sha256=${digest}` : digest,
  };
}
async function deliver(
  options: {
    provider?: string;
    body?: string;
    id?: string;
    secret?: string;
    headers?: Record<string, string>;
    method?: string;
  } = {},
) {
  const provider = options.provider ?? 'github';
  const id = options.id ?? randomUUID();
  const body =
    options.body ??
    JSON.stringify({
      ...payload(provider),
      after: createHash('sha256').update(id).digest('hex').slice(0, 40),
    });
  return call(ingress.POST, {
    method: options.method ?? 'POST',
    origin: null,
    path: `/api/webhooks/git/${workspaceId}/${repositoryId}`,
    params: params(),
    body,
    headers: { ...headers(provider, body, id, options.secret), ...options.headers },
  });
}
function db() {
  return openSqlite(h.config.databasePath);
}
function rows(table: string) {
  const handle = db();
  try {
    return handle.db.$client.prepare(`SELECT * FROM ${table}`).all();
  } finally {
    handle.close();
  }
}

describe('signed Git ingress via actual routes, SQLite and queue', () => {
  it.each(providers)('accepts native %s push bytes and only enqueues a repository sync', async (provider) => {
    const handle = db();
    handle.db.$client
      .prepare('UPDATE git_repository_connections SET git_provider_type = ?, remote_url = ? WHERE id = ?')
      .run(
        provider,
        provider === 'github'
          ? 'https://github.com/acme/infra.git'
          : `https://${provider}.example/acme/infra.git`,
        repositoryId,
      );
    handle.close();
    expect((await configure()).status).toBe(200);
    const nudge = vi.spyOn(h.container.worker, 'nudge');
    const result = await deliver({ provider });
    expect(result.status).toBe(202);
    expect(nudge).toHaveBeenCalledOnce();
    expect(rows('jobs')).toMatchObject([
      { type: 'repository_sync', payload: JSON.stringify({ repositoryId }), status: 'pending' },
    ]);
    expect(rows('git_webhook_deliveries')).toMatchObject([
      {
        repository_id: repositoryId,
        provider,
        event_type: 'push',
        ref: 'refs/heads/main',
        status: 'accepted',
      },
    ]);
    expect(fs.existsSync(path.join(h.config.reposDir, repositoryId))).toBe(false);
  });
  it.each([
    ['wrong secret', { secret: ROTATED }],
    ['missing signature', { headers: { 'x-hub-signature-256': '' } }],
    ['malformed signature', { headers: { 'x-hub-signature-256': 'sha256=nope' } }],
    ['SHA1 only', { headers: { 'x-hub-signature-256': '', 'x-hub-signature': 'sha1=' + 'a'.repeat(40) } }],
    ['wrong native headers', { provider: 'gitea' }],
  ] as const)('rejects %s without work', async (_name, options) => {
    await configure();
    expect((await deliver(options)).status).toBe(401);
    expect(rows('jobs')).toHaveLength(0);
    expect(rows('git_webhook_deliveries')).toHaveLength(0);
  });
  it('rejects modified raw bytes and accepts Unicode and whitespace without normalization', async () => {
    await configure();
    const body = JSON.stringify({ ...payload(), note: 'こんにちは 👋 café' }) + '\n';
    expect((await deliver({ body })).status).toBe(202);
    const signed = headers('github', body);
    expect((await deliver({ body: body + ' ', headers: signed })).status).toBe(401);
  });
  it('enforces POST, exact JSON media type and streamed/declared byte limits', async () => {
    await configure();
    expect((await deliver({ method: 'PUT' })).status).toBe(405);
    for (const type of [
      'text/plain',
      'application/x-www-form-urlencoded',
      'application/jsonp',
      'application/json; charset=iso-8859-1',
    ]) {
      expect((await deliver({ headers: { 'content-type': type } })).status).toBe(415);
    }
    expect((await deliver({ body: 'x'.repeat(1024 * 1024 + 1) })).status).toBe(413);
    expect((await deliver({ headers: { 'content-length': '1048577' } })).status).toBe(413);
    expect(rows('jobs')).toHaveLength(0);
  });
  it('authenticates before JSON parsing and rejects malformed signed payloads', async () => {
    await configure();
    expect((await deliver({ body: '{', secret: ROTATED })).status).toBe(401);
    for (const body of ['{', 'null', '[]', '{}', JSON.stringify({ ...payload(), after: 'not-a-sha' })]) {
      expect((await deliver({ body })).status).toBe(400);
    }
    expect(rows('jobs')).toHaveLength(0);
  });
  it.each(['', 'bad delivery', 'x'.repeat(129)])('rejects invalid delivery id %s', async (id) => {
    await configure();
    expect((await deliver({ headers: { 'x-github-delivery': id } })).status).toBe(400);
    expect(rows('jobs')).toHaveLength(0);
  });
  it('safely ignores unsupported events, branches, tags and deletions', async () => {
    await configure();
    expect((await deliver({ body: '{}', headers: { 'x-github-event': 'ping' } })).status).toBe(200);
    for (const change of [
      { ref: 'refs/heads/other' },
      { ref: 'refs/tags/main' },
      { deleted: true },
      { after: '0'.repeat(40) },
    ]) {
      expect((await deliver({ body: JSON.stringify({ ...payload(), ...change }) })).status).toBe(200);
    }
    expect(rows('jobs')).toHaveLength(0);
  });
  it('does not authorize by payload identity: enforces stored full HTTPS remote including host', async () => {
    await configure();
    for (const clone_url of [
      'https://evil.example/acme/infra.git',
      'https://github.com/other/infra.git',
      'https://github.com/acme/infra.git?token=x',
      'http://github.com/acme/infra.git',
    ]) {
      const p = payload();
      p.repository = { ...(p.repository as object), clone_url };
      expect((await deliver({ body: JSON.stringify(p) })).status).toBe(200);
    }
    expect(rows('jobs')).toHaveLength(0);
  });
  it('durably deduplicates simultaneous and sequential deliveries, including after restart', async () => {
    await configure();
    const id = randomUUID();
    const results = await Promise.all([deliver({ id }), deliver({ id }), deliver({ id })]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 202]);
    expect(rows('jobs')).toHaveLength(1);
    expect(rows('git_webhook_deliveries')).toHaveLength(1);
    await h.container.close();
    h = await createHarness({ dataDir: h.dataDir, config: h.config });
    expect((await deliver({ id })).status).toBe(200);
    expect(rows('jobs')).toHaveLength(1);
  });
  it('rolls back delivery insertion if job persistence fails and accepts a retry', async () => {
    await configure();
    const id = randomUUID();
    const handle = db();
    handle.db.$client.exec(
      "CREATE TRIGGER fail_job BEFORE INSERT ON jobs BEGIN SELECT RAISE(ABORT, 'synthetic storage failure'); END",
    );
    expect((await deliver({ id })).status).toBe(500);
    expect(rows('git_webhook_deliveries')).toHaveLength(0);
    handle.db.$client.exec('DROP TRIGGER fail_job');
    handle.close();
    expect((await deliver({ id })).status).toBe(202);
  });
  it('fails safely on delivery database failure', async () => {
    await configure();
    const handle = db();
    handle.db.$client.exec(
      "CREATE TRIGGER fail_delivery BEFORE INSERT ON git_webhook_deliveries BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END",
    );
    expect((await deliver()).status).toBe(500);
    expect(rows('jobs')).toHaveLength(0);
    handle.close();
  });
  it('coalesces pending fetches and durably requests another fetch while running', async () => {
    await configure();
    const id = randomUUID();
    await deliver({ id });
    await deliver();
    expect(rows('jobs')).toHaveLength(1);
    const running = await h.container.repos.jobs.claimNext('worker', h.clock.now(), 1000, [
      'repository_sync',
    ]);
    expect(running).not.toBeNull();
    await deliver({ id });
    expect(rows('jobs')).toMatchObject([{ follow_up_requested: 0 }]);
    await deliver();
    await deliver();
    expect(rows('jobs')).toMatchObject([{ follow_up_requested: 1 }]);
    await h.container.repos.jobs.markSucceeded(running!.id, 'worker', h.clock.now());
    expect((await h.container.jobs.get(running!.id))!.status).toBe('pending');
  });
  it('recovers a running fetch and its follow-up after restart', async () => {
    await configure();
    await deliver();
    const job = await h.container.repos.jobs.claimNext('dead-worker', h.clock.now(), 1000, [
      'repository_sync',
    ]);
    await deliver();
    await h.container.close();
    h = await createHarness({ dataDir: h.dataDir, config: h.config });
    h.clock.advance(2000);
    expect(await h.container.repos.jobs.reclaimExpired(h.clock.now(), () => 0)).toMatchObject({
      requeued: 1,
    });
    const recovered = await h.container.repos.jobs.claimNext('new-worker', h.clock.now(), 1000, [
      'repository_sync',
    ]);
    expect(recovered!.id).toBe(job!.id);
  });
});

describe('webhook signing configuration', () => {
  it('requires authenticated same-origin configuration, preserving ordinary public CSRF', async () => {
    expect(
      (await call(settings.PUT, { method: 'PUT', params: params(), body: { secret: SECRET } })).status,
    ).toBe(401);
    expect((await call(settings.GET, { params: params() })).status).toBe(401);
    expect((await call(settings.DELETE, { method: 'DELETE', params: params() })).status).toBe(401);
    expect(
      (
        await call(settings.PUT, {
          method: 'PUT',
          cookie,
          origin: null,
          params: params(),
          body: { secret: SECRET },
        })
      ).status,
    ).toBe(403);
    expect((await call(setup.POST, { method: 'POST', origin: null, body: {} })).status).toBe(403);
  });
  it('requires a strong dedicated credential and supports masked state, rotation and disabling', async () => {
    expect((await configure('short')).status).toBe(400);
    expect((await configure('a'.repeat(40))).status).toBe(400);
    const saved = await configure();
    expect(saved.status).toBe(200);
    expect(saved.text).not.toContain(SECRET);
    expect(saved.text).toContain('••••');
    const conn = (await h.container.repos.gitRepositories.findById(workspaceId, repositoryId))!;
    const credential = await h.container.credentials.get(workspaceId, conn.webhookCredentialId!);
    expect(credential.kind).toBe('git_webhook');
    await expect(h.container.credentials.delete(workspaceId, credential.id, actor)).rejects.toThrow(/in use/);
    expect((await deliver()).status).toBe(202);
    expect((await configure(ROTATED)).status).toBe(200);
    expect((await deliver()).status).toBe(401);
    expect((await deliver({ secret: ROTATED })).status).toBe(202);
    expect((await call(settings.DELETE, { method: 'DELETE', cookie, params: params() })).status).toBe(200);
    expect((await deliver({ secret: ROTATED })).status).toBe(401);
    const all =
      JSON.stringify(await h.container.audit.list({ workspaceId, limit: 100 })) +
      h.logs.join('\n') +
      JSON.stringify(rows('jobs')) +
      JSON.stringify(rows('git_webhook_deliveries'));
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain(ROTATED);
  });
  it('fails closed for missing, cross-workspace, wrong-kind or wrong-provider credentials', async () => {
    expect((await deliver()).status).toBe(401);
    const other = await h.container.workspaces.create({ name: 'Other' }, actor);
    for (const [wid, kind, provider] of [
      [other.id, 'git_webhook', 'github'],
      [workspaceId, 'git', 'github'],
      [workspaceId, 'git_webhook', 'gitea'],
    ] as const) {
      const cred = await h.container.credentials.create(
        { workspaceId: wid, kind, providerType: provider, label: 'Signing', secret: SECRET },
        actor,
      );
      expect(
        (
          await call(settings.PUT, {
            method: 'PUT',
            cookie,
            params: params(),
            body: { credentialId: cred.id },
          })
        ).status,
      ).toBeGreaterThanOrEqual(400);
      await h.container.repos.gitRepositories.update(repositoryId, {
        webhookCredentialId: cred.id,
        updatedAt: h.clock.now(),
      });
      expect((await deliver()).status).toBe(401);
    }
    expect(rows('jobs')).toHaveLength(0);
  });
});

describe('verification/configuration races and background Git work', () => {
  it.each(['rotate', 'disable'] as const)(
    'fences an in-flight delivery against concurrent %s',
    async (operation) => {
      await configure();
      const accept = h.container.repos.gitWebhookDeliveries.accept.bind(
        h.container.repos.gitWebhookDeliveries,
      );
      vi.spyOn(h.container.repos.gitWebhookDeliveries, 'accept').mockImplementationOnce(async (...args) => {
        if (operation === 'rotate') await configure(ROTATED);
        else await call(settings.DELETE, { method: 'DELETE', cookie, params: params() });
        return accept(...args);
      });
      expect((await deliver()).status).toBe(401);
      expect(rows('jobs')).toHaveLength(0);
      expect(rows('git_webhook_deliveries')).toHaveLength(0);
    },
  );

  it('executes accepted work after restart through the existing worker and real Git provider', async () => {
    const server = await startGitServer();
    try {
      server.createRepo('acme/infra.git');
      await h.container.close();
      h = await createHarness({
        dataDir: h.dataDir,
        config: h.config,
        overrides: gitServerOverrides(server),
      });
      const handle = db();
      handle.db.$client
        .prepare('UPDATE git_repository_connections SET remote_url = ? WHERE id = ?')
        .run('https://git.test/acme/infra.git', repositoryId);
      handle.close();
      await configure();
      const p = payload();
      p.repository = { ...(p.repository as object), clone_url: 'https://git.test/acme/infra.git' };
      expect((await deliver({ body: JSON.stringify(p) })).status).toBe(202);
      expect(server.requestUrls).toHaveLength(0);
      await h.container.close();
      h = await createHarness({
        dataDir: h.dataDir,
        config: h.config,
        overrides: gitServerOverrides(server),
      });
      expect(await h.container.worker.runOnce()).toBe(true);
      expect(rows('jobs')).toMatchObject([{ type: 'repository_sync', status: 'succeeded' }]);
      const conn = await h.container.repos.gitRepositories.findById(workspaceId, repositoryId);
      expect(conn!.syncStatus).toBe('ready');
      expect(conn!.headSha).toMatch(/^[a-f0-9]{40}$/);
      expect(server.requestUrls.length).toBeGreaterThan(0);
    } finally {
      await server.close();
    }
  });
});

describe('clone/push credential isolation', () => {
  it('never sends a webhook signing key or mismatched provider credential to Git', async () => {
    await configure();
    const conn = (await h.container.repos.gitRepositories.findById(workspaceId, repositoryId))!;
    const probe = vi
      .spyOn(h.container.gitProviders.get('github'), 'testConnection')
      .mockResolvedValue({ defaultBranch: 'main', branches: ['main'] });
    for (const provider of ['github', 'gitea']) {
      const id =
        provider === 'github'
          ? conn.webhookCredentialId!
          : (
              await h.container.credentials.create(
                { workspaceId, kind: 'git', providerType: 'gitea', label: 'Wrong provider', secret: SECRET },
                actor,
              )
            ).id;
      const body = {
        gitProviderType: 'github',
        remoteUrl: 'https://github.com/attacker/infra.git',
        auth: { type: 'credential', credentialId: id },
      };
      for (const handler of [testConnection.POST, connectRepository.POST]) {
        expect((await call(handler, { method: 'POST', cookie, params: { workspaceId }, body })).status).toBe(
          400,
        );
      }
    }
    expect(probe).not.toHaveBeenCalled();
  });
});

describe('SQLite connection and configuration boundaries', () => {
  it('deduplicates overlapping HTTP handlers backed by independent SQLite connections', async () => {
    await configure();
    const second = await createHarness({ dataDir: h.dataDir, config: h.config });
    try {
      const id = randomUUID();
      setContainer(h.container);
      const firstRequest = deliver({ id });
      setContainer(second.container);
      const secondRequest = deliver({ id });
      expect((await Promise.all([firstRequest, secondRequest])).map((r) => r.status).sort()).toEqual([
        200, 202,
      ]);
      expect(rows('jobs')).toHaveLength(1);
      expect(rows('git_webhook_deliveries')).toHaveLength(1);
    } finally {
      await second.cleanup();
      setContainer(h.container);
    }
  });
  it.each(['defaultBranch', 'remoteUrl'] as const)(
    'fences a verified delivery against a concurrent %s change',
    async (field) => {
      await configure();
      const accept = h.container.repos.gitWebhookDeliveries.accept.bind(
        h.container.repos.gitWebhookDeliveries,
      );
      vi.spyOn(h.container.repos.gitWebhookDeliveries, 'accept').mockImplementationOnce(async (...args) => {
        await h.container.repos.gitRepositories.update(repositoryId, {
          [field]: field === 'defaultBranch' ? 'other' : 'https://github.com/other/infra.git',
          updatedAt: h.clock.now(),
        });
        return accept(...args);
      });
      expect((await deliver()).status).toBe(401);
      expect(rows('jobs')).toHaveLength(0);
      expect(rows('git_webhook_deliveries')).toHaveLength(0);
    },
  );
  it('rejects corrupted outbound Git credential links before clone, commit or push access', async () => {
    await configure();
    const conn = (await h.container.repos.gitRepositories.findById(workspaceId, repositoryId))!;
    await h.container.repos.gitRepositories.update(repositoryId, {
      credentialId: conn.webhookCredentialId,
      updatedAt: h.clock.now(),
    });
    const provider = h.container.gitProviders.get('github');
    const sync = vi.spyOn(provider, 'syncClone');
    const operation = vi.fn();
    await expect(
      h.container.repositories.withGitAccess(workspaceId, repositoryId, operation),
    ).rejects.toThrow(/kind or provider/);
    await expect(h.container.repositories.sync(repositoryId)).rejects.toThrow();
    expect(operation).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
  });
});

describe('signed-body replay protection', () => {
  it('deduplicates simultaneous changed-ID bodies and retains fingerprints across rotation', async () => {
    await configure();
    const body = JSON.stringify(payload());
    const results = await Promise.all([deliver({ body }), deliver({ body }), deliver({ body })]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 202]);
    expect(rows('git_webhook_deliveries')).toHaveLength(1);
    await configure(ROTATED);
    expect((await deliver({ body, secret: ROTATED })).json.result).toBe('duplicate');
    expect(rows('jobs')).toHaveLength(1);
  });
  it('does not let an ignored event reserve a relevant push fingerprint', async () => {
    await configure();
    const body = JSON.stringify(payload());
    expect((await deliver({ body, headers: { 'x-github-event': 'ping' } })).json.result).toBe('ignored');
    expect((await deliver({ body })).status).toBe(202);
    expect(rows('git_webhook_deliveries')).toMatchObject([
      { body_hash: null },
      { body_hash: expect.stringMatching(/^[a-f0-9]{64}$/) },
    ]);
  });

  it.each(providers)(
    'deduplicates a captured %s body with a changed delivery ID, also while running',
    async (provider) => {
      const handle = db();
      handle.db.$client
        .prepare('UPDATE git_repository_connections SET git_provider_type = ?, remote_url = ? WHERE id = ?')
        .run(
          provider,
          provider === 'github'
            ? 'https://github.com/acme/infra.git'
            : `https://${provider}.example/acme/infra.git`,
          repositoryId,
        );
      handle.close();
      await configure();
      const body = JSON.stringify(payload(provider));
      expect((await deliver({ provider, body })).status).toBe(202);
      const running = await h.container.repos.jobs.claimNext('worker', h.clock.now(), 1000, [
        'repository_sync',
      ]);
      expect(running).not.toBeNull();
      expect((await deliver({ provider, body })).json.result).toBe('duplicate');
      expect(rows('jobs')).toMatchObject([{ follow_up_requested: 0 }]);
      expect(rows('git_webhook_deliveries')).toHaveLength(1);
      await h.container.repos.jobs.markSucceeded(running!.id, 'worker', h.clock.now());
      await h.container.close();
      h = await createHarness({ dataDir: h.dataDir, config: h.config });
      expect((await deliver({ provider, body })).json.result).toBe('duplicate');
      expect(rows('jobs')).toHaveLength(1);
    },
  );
});

describe('public webhook request throttling', () => {
  it('bounds unattributed traffic across attacker-chosen repository IDs', async () => {
    const configuredId = repositoryId;
    for (let i = 0; i < 120; i++) {
      repositoryId = randomUUID();
      expect((await deliver()).status).toBe(401);
    }
    repositoryId = configuredId;
    expect((await deliver()).status).toBe(429);
  });

  it('limits before body/credential work, ignores untrusted forwarding headers and recovers', async () => {
    await configure();
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const lookup = vi.spyOn(h.container.repos.credentials, 'findById');
    for (let i = 0; i < 120; i++) {
      expect((await deliver({ secret: ROTATED })).status).toBe(401);
    }
    lookup.mockClear();
    expect(
      (await deliver({ headers: { 'content-type': 'text/plain', 'x-forwarded-for': '203.0.113.8' } })).status,
    ).toBe(429);
    expect(lookup).not.toHaveBeenCalled();
    now.mockReturnValue(61000);
    expect((await deliver()).status).toBe(202);
  });
  it('isolates trusted client IP quotas', async () => {
    await configure();
    await h.container.close();
    h = await createHarness({ dataDir: h.dataDir, config: { ...h.config, trustedProxyHops: 1 } });
    for (let i = 0; i < 120; i++) {
      expect((await deliver({ secret: ROTATED, headers: { 'x-forwarded-for': '203.0.113.8' } })).status).toBe(
        401,
      );
    }
    expect((await deliver({ headers: { 'x-forwarded-for': '1.2.3.4, 203.0.113.8' } })).status).toBe(429);
    expect((await deliver({ headers: { 'x-forwarded-for': '203.0.113.9' } })).status).toBe(202);
  });
});
