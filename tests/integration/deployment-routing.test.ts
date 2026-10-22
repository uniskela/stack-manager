import { createHmac, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as setup from '@/app/api/setup/route';
import * as preview from '@/app/api/workspaces/[workspaceId]/stacks/[stackId]/deployment/preview/route';
import { DEFAULT_ROUTING_POLICY } from '@/shared/deployment-routing';
import { DeploymentService } from '@/server/application/deployment-service';
import { openSqlite } from '@/server/persistence/sqlite/database';
import { GitCli } from '@/server/providers/git/git-cli';
import { createHarness, type TestHarness } from '../support/container';
import { startGitServer, gitServerOverrides, type GitServer } from '../support/git-server';
import { call, cookieFrom } from '../support/http';

let h: TestHarness, server: GitServer, actor: string, cookie: string;
const workspaceId = 'home',
  repositoryId = 'infra';
const signingSecret = 'synthetic-signing-material-for-routing-tests';
const trigger = vi.fn();
const policy = { ...DEFAULT_ROUTING_POLICY, dependencies: ['shared/proxy/**'] };
const params = { workspaceId, stackId: 'wiki' };

function sql<T = Record<string, unknown>>(statement: string, ...values: unknown[]): T[] {
  const handle = openSqlite(h.config.databasePath);
  try {
    const prepared = handle.db.$client.prepare(statement);
    if (prepared.reader) return prepared.all(...values) as T[];
    prepared.run(...values);
    return [];
  } finally {
    handle.close();
  }
}
async function drain() {
  for (let i = 0; i < 30 && (await h.container.worker.runOnce()); i++) {
    /* bounded test drain */
  }
}
async function optIn(stackId = 'wiki', deployOnPush = true) {
  const b = (await h.container.deployments.settings(workspaceId, stackId)).binding;
  return h.container.deployments.configure(
    workspaceId,
    stackId,
    {
      providerType: 'generic-webhook',
      enabled: true,
      expectedRevision: b?.revision ?? null,
      ...(b ? {} : { configuration: { url: 'https://hooks.example.test/deploy/synthetic' } }),
      deployOnPush,
      routingPolicy: policy,
    },
    actor,
  );
}
async function deliver(sha: string, id = randomUUID(), extra: Record<string, unknown> = {}) {
  const body = JSON.stringify({
    ref: 'refs/heads/main',
    after: sha,
    deleted: false,
    repository: { clone_url: 'https://git.test/infra.git' },
    ...extra,
  });
  const headers = new Headers({
    'x-github-event': 'push',
    'x-github-delivery': id,
    'x-hub-signature-256': `sha256=${createHmac('sha256', signingSecret).update(body).digest('hex')}`,
  });
  return h.container.gitWebhooks.receive(workspaceId, repositoryId, headers, Buffer.from(body));
}
const change = (files: Record<string, string | null>) => server.commitFiles('infra.git', 'main', files);
const decisions = (stackId = 'wiki') => h.container.repos.routing.history(workspaceId, stackId);
async function restart() {
  const dataDir = h.dataDir,
    config = h.config;
  await h.container.close();
  h = await createHarness({ dataDir, config, overrides: gitServerOverrides(server) });
  mockSend();
}
function mockSend() {
  const provider = {
    type: 'generic-webhook' as const,
    validateConfiguration: (v: unknown) => v as { url: string },
    validateDestination: async () => {},
    trigger,
  };
  const service = new DeploymentService(
    h.container.repos,
    h.container.credentials,
    new Map([['generic-webhook', provider]]),
    h.container.jobs,
    h.container.audit,
    h.clock,
    randomUUID,
  );
  vi.spyOn(h.container.deployments, 'execute').mockImplementation((job, ctx) => service.execute(job, ctx));
}
beforeEach(async () => {
  server = await startGitServer();
  server.createRepo('infra.git');
  change({
    'apps/wiki/compose.yaml': 'services: {}',
    'apps/notes/compose.yaml': 'services: {}',
    'media/photos/compose.yaml': 'services: {}',
  });
  h = await createHarness({ overrides: gitServerOverrides(server) });
  const user = await call(setup.POST, {
    method: 'POST',
    body: { username: 'admin', password: 'correct horse battery staple' },
  });
  actor = user.json.user.id;
  cookie = cookieFrom(user);
  await h.container.workspaces.create({ name: 'Home' }, actor);
  const now = h.clock.now();
  await h.container.repos.workspaces.insert({
    id: workspaceId,
    name: 'Home',
    slug: 'routing-home',
    createdAt: now,
    updatedAt: now,
  });
  await h.container.repos.gitRepositories.insert({
    id: repositoryId,
    workspaceId,
    name: 'Infra',
    gitProviderType: 'github',
    remoteUrl: 'https://git.test/infra.git',
    defaultBranch: 'main',
    credentialId: null,
    webhookCredentialId: null,
    localClonePath: `repos/${repositoryId}`,
    syncStatus: 'pending',
    headSha: null,
    lastSyncError: null,
    lastFetchedAt: null,
    lastSyncAttemptAt: null,
    lastSyncFailedAt: null,
    lastHeadChangedAt: null,
    autoAddStacks: false,
    autoFetchEnabled: false,
    autoFetchIntervalMinutes: null,
    createdAt: now,
    updatedAt: now,
  });
  await h.container.repositories.sync(repositoryId);
  for (const [id, root] of [
    ['wiki', 'apps/wiki'],
    ['notes', 'apps/notes'],
    ['photos', 'media/photos'],
  ] as const)
    await h.container.repos.stacks.insert({
      id,
      workspaceId,
      repositoryId,
      name: id,
      slug: id,
      rootPath: root,
      composePath: `${root}/compose.yaml`,
      createdAt: now,
      updatedAt: now,
    });
  await h.container.gitWebhooks.configure(workspaceId, repositoryId, { secret: signingSecret }, actor);
  trigger.mockReset().mockResolvedValue({ status: 'accepted', httpStatus: 204 });
  mockSend();
});
afterEach(async () => {
  vi.restoreAllMocks();
  const dir = h.dataDir;
  await h.cleanup();
  fs.rmSync(dir, { recursive: true, force: true });
  await server.close();
});

describe('durable selective deployment worker', () => {
  it('defaults off, establishes a baseline without sending, and deploys only the relevant registered stack', async () => {
    await optIn('wiki', false);
    expect((await h.container.deployments.settings(workspaceId, 'wiki')).binding!.deployOnPush).toBe(false);
    await optIn();
    await optIn('notes');
    await optIn('photos', false);
    expect(trigger).not.toHaveBeenCalled();
    const sha = change({ 'apps/wiki/compose.yaml': 'services: {wiki: {image: nginx}}' });
    await deliver(sha);
    await drain();
    expect(trigger).toHaveBeenCalledTimes(1);
    expect((await h.container.deployments.history(workspaceId, 'wiki')).attempts[0]).toMatchObject({
      triggerType: 'automatic',
      status: 'accepted',
    });
    expect((await decisions())[0]).toMatchObject({
      decision: 'deploy',
      afterSha: sha,
      matchedPaths: ['apps/wiki/compose.yaml'],
    });
    expect((await decisions('notes'))[0]!.decision).toBe('skip');
    expect((await decisions('photos'))[0]!.reasonCode).toBe('deploy_on_push_disabled');
  });
  it('skips README-only changes and never trusts payload changed-file lists', async () => {
    await optIn();
    const sha = change({ 'apps/wiki/README.md': 'docs' });
    await deliver(sha, randomUUID(), { commits: [{ modified: ['apps/wiki/compose.yaml'] }] });
    await drain();
    expect(trigger).not.toHaveBeenCalled();
    expect((await decisions())[0]!.reasonCode).toBe('no_relevant_changes');
  });
  it('independently deploys two stacks for a shared dependency, never photos', async () => {
    await optIn();
    await optIn('notes');
    await optIn('photos', false);
    const sha = change({ 'shared/proxy/nginx.conf': 'proxy' });
    await deliver(sha);
    await drain();
    expect(trigger).toHaveBeenCalledTimes(2);
    for (const stack of ['wiki', 'notes'])
      expect((await decisions(stack))[0]!.matchedPaths).toEqual(['shared/proxy/nginx.conf']);
    expect((await h.container.deployments.history(workspaceId, 'photos')).attempts).toEqual([]);
  });
  it('covers multiple commits and two pushes coalesced before fetch, with no replay or same-change resend', async () => {
    await optIn();
    const one = change({ 'apps/wiki/config/a': 'a' });
    const two = change({ 'apps/wiki/config/b': 'b' });
    const id = randomUUID();
    await deliver(one, id);
    await deliver(two);
    await drain();
    // Both sources are durable. A later source is either explicitly blocked by an active attempt or already covered.
    expect(trigger).toHaveBeenCalledTimes(1);
    expect(await decisions()).toHaveLength(2);
    expect(await deliver(one, id)).toBe('duplicate');
    expect(await deliver(one)).toBe('duplicate');
    await deliver(two, randomUUID(), { extra: 'distinct signed bytes' });
    await drain();
    expect(trigger).toHaveBeenCalledTimes(1);
  });
  it('manual fetch, polling and in-app refresh alone cannot create deployment attempts', async () => {
    await optIn();
    change({ 'apps/wiki/compose.yaml': 'new' });
    await h.container.repositories.requestSync(workspaceId, repositoryId, actor);
    await drain();
    await h.container.repositories.schedulePostPushRefresh(repositoryId);
    await drain();
    await h.container.repositories.sync(repositoryId);
    await h.container.deploymentRouting.schedule(repositoryId);
    await drain();
    expect(trigger).not.toHaveBeenCalled();
    expect(await decisions()).toEqual([]);
  });
  it('rejects opt-in without saved policy, enabled binding or synchronized signed baseline', async () => {
    const b = (await optIn('wiki', false)).binding!;
    await expect(
      h.container.deployments.configure(
        workspaceId,
        'wiki',
        { providerType: 'generic-webhook', enabled: false, expectedRevision: b.revision, deployOnPush: true },
        actor,
      ),
    ).rejects.toThrow('Automatic deployment requires');
    await h.container.repos.gitRepositories.update(repositoryId, { headSha: null, updatedAt: h.clock.now() });
    await expect(optIn()).rejects.toThrow('baseline');
    expect(trigger).not.toHaveBeenCalled();
  });
  it('recovers after restart before fetch and after fetch before routing', async () => {
    await optIn();
    const sha = change({ 'apps/wiki/config/new': 'new' });
    await deliver(sha);
    await restart();
    await h.container.worker.runOnce();
    expect(trigger).not.toHaveBeenCalled();
    await restart();
    await drain();
    expect(trigger).toHaveBeenCalledTimes(1);
  });
  it('does not duplicate a send after routing committed and the route worker restarts', async () => {
    await optIn();
    await deliver(change({ 'apps/wiki/config/a': 'a' }));
    await h.container.worker.runOnce();
    await h.container.worker.runOnce();
    expect((await decisions())[0]!.decision).toBe('deploy');
    expect(trigger).not.toHaveBeenCalled();
    await restart();
    await drain();
    expect(trigger).toHaveBeenCalledTimes(1);
    await h.container.deploymentRouting.schedule(repositoryId);
    await drain();
    expect(trigger).toHaveBeenCalledTimes(1);
  });
  it('retries lookup failures without skipping sources or advancing shared checkpoints across restart', async () => {
    await optIn();
    await optIn('notes');
    const baseline = (await h.container.deployments.settings(workspaceId, 'wiki')).binding!.routingHeadSha;
    await deliver(change({ 'apps/wiki/config/a': 'a' }));
    h.clock.advance(1);
    await deliver(change({ 'apps/notes/config/b': 'b' }));
    await h.container.worker.runOnce();
    const lookup = vi
      .spyOn(h.container.repos.gitRepositories, 'findByIdUnscoped')
      .mockRejectedValueOnce(new Error('simulated repository lookup failure'));
    await h.container.worker.runOnce();
    expect(await decisions()).toEqual([]);
    expect(await decisions('notes')).toEqual([]);
    expect(sql('SELECT * FROM deployment_attempts')).toEqual([]);
    expect(sql("SELECT * FROM jobs WHERE type = 'deployment_trigger'")).toEqual([]);
    expect(sql('SELECT * FROM git_webhook_deliveries WHERE processed_at IS NULL')).toHaveLength(2);
    expect(sql("SELECT status, attempts, last_error FROM jobs WHERE type = 'deployment_route'")).toEqual([
      { status: 'pending', attempts: 1, last_error: 'Error: simulated repository lookup failure' },
    ]);
    for (const stackId of ['wiki', 'notes'])
      expect((await h.container.deployments.settings(workspaceId, stackId)).binding!.routingHeadSha).toBe(
        baseline,
      );
    lookup.mockRestore();
    await restart();
    h.clock.advance(6000);
    await drain();
    expect(trigger).toHaveBeenCalledTimes(2);
    for (const stackId of ['wiki', 'notes']) {
      expect(await decisions(stackId)).toHaveLength(2);
      expect((await decisions(stackId)).filter((d) => d.decision === 'deploy')).toHaveLength(1);
    }
    expect(sql('SELECT * FROM git_webhook_deliveries WHERE processed_at IS NULL')).toEqual([]);
    await h.container.deploymentRouting.schedule(repositoryId);
    await drain();
    expect(trigger).toHaveBeenCalledTimes(2);
  });
  it('rolls back earlier stacks when a later enqueue interrupts the routing transaction', async () => {
    await optIn();
    await optIn('notes');
    const baseline = (await h.container.deployments.settings(workspaceId, 'wiki')).binding!.routingHeadSha;
    await deliver(change({ 'shared/proxy/nginx.conf': 'config' }));
    await h.container.worker.runOnce();
    // Notes is enqueued first; failing Wiki must roll back that earlier attempt and job too.
    sql(
      "CREATE TRIGGER routing_test_abort BEFORE INSERT ON deployment_attempts WHEN NEW.stack_id = 'wiki' BEGIN SELECT RAISE(ABORT, 'simulated crash'); END",
    );
    await h.container.worker.runOnce();
    for (const stackId of ['wiki', 'notes']) {
      expect(await decisions(stackId)).toEqual([]);
      expect((await h.container.deployments.settings(workspaceId, stackId)).binding!.routingHeadSha).toBe(
        baseline,
      );
    }
    expect(sql('SELECT * FROM deployment_attempts')).toEqual([]);
    expect(sql("SELECT * FROM jobs WHERE type = 'deployment_trigger'")).toEqual([]);
    expect(sql('SELECT * FROM git_webhook_deliveries WHERE processed_at IS NULL')).toHaveLength(1);
    sql('DROP TRIGGER routing_test_abort');
    h.clock.advance(6000);
    await drain();
    expect(trigger).toHaveBeenCalledTimes(2);
    for (const stackId of ['wiki', 'notes']) expect((await decisions(stackId))[0]!.decision).toBe('deploy');
  });
  it.each(['disable', 'remove', 'rotate', 'signing'] as const)(
    'blocks %s between queue and execution',
    async (operation) => {
      await optIn();
      await deliver(change({ 'apps/wiki/config/a': 'a' }));
      await h.container.worker.runOnce();
      await h.container.worker.runOnce();
      const b = (await h.container.deployments.settings(workspaceId, 'wiki')).binding!;
      if (operation === 'disable')
        await h.container.deployments.configure(
          workspaceId,
          'wiki',
          { providerType: 'generic-webhook', enabled: false, expectedRevision: b.revision },
          actor,
        );
      if (operation === 'remove')
        await h.container.deployments.remove(workspaceId, 'wiki', actor, b.revision);
      if (operation === 'rotate')
        await h.container.credentials.replaceSecret(
          workspaceId,
          b.credentialId,
          JSON.stringify({ url: 'https://hooks.example.test/new' }),
          actor,
        );
      if (operation === 'signing')
        await h.container.gitWebhooks.configure(
          workspaceId,
          repositoryId,
          { secret: `${signingSecret}-rotated` },
          actor,
        );
      await drain();
      expect(trigger).not.toHaveBeenCalled();
      expect((await h.container.deployments.history(workspaceId, 'wiki')).attempts[0]!.status).toBe(
        'rejected',
      );
    },
  );
  it('records later intent while manual request is active, without losing or sending it', async () => {
    await optIn();
    await h.container.deployments.trigger(workspaceId, 'wiki', actor);
    // Claim the manual request so the route worker can evaluate while that attempt remains active.
    await h.container.repos.jobs.claimNext('manual-worker', h.clock.now(), 60000, ['deployment_trigger']);
    const sha = change({ 'apps/wiki/config/a': 'a' });
    await deliver(sha);
    await drain();
    expect(trigger).not.toHaveBeenCalled();
    expect((await decisions())[0]).toMatchObject({
      decision: 'blocked',
      reasonCode: 'deployment_active',
      afterSha: sha,
    });
  });
  it.each(['accepted', 'rejected', 'unknown'] as const)(
    'persists %s without blind send retry',
    async (status) => {
      await optIn();
      trigger.mockResolvedValue({
        status,
        httpStatus: status === 'unknown' ? null : status === 'accepted' ? 204 : 403,
      });
      const sha = change({ 'apps/wiki/config/a': 'a' });
      await deliver(sha);
      await drain();
      expect((await h.container.deployments.history(workspaceId, 'wiki')).attempts[0]!.status).toBe(status);
      await restart();
      await h.container.deploymentRouting.schedule(repositoryId);
      await drain();
      expect(trigger).toHaveBeenCalledTimes(1);
      if (status === 'unknown') {
        await deliver(change({ 'apps/wiki/config/b': 'b' }));
        await drain();
        expect(trigger).toHaveBeenCalledTimes(1);
        expect((await decisions())[0]).toMatchObject({ decision: 'blocked', reasonCode: 'outcome_unknown' });
        const b = (await h.container.deployments.settings(workspaceId, 'wiki')).binding!;
        await h.container.deployments.configure(
          workspaceId,
          'wiki',
          {
            providerType: 'generic-webhook',
            enabled: true,
            expectedRevision: b.revision,
            deployOnPush: true,
            routingPolicy: policy,
          },
          actor,
        );
        expect((await h.container.deployments.settings(workspaceId, 'wiki')).binding!.automationHold).toBe(
          true,
        );
        trigger.mockResolvedValue({ status: 'accepted', httpStatus: 204 });
        await h.container.deployments.trigger(workspaceId, 'wiki', actor);
        await drain();
        expect((await h.container.deployments.settings(workspaceId, 'wiki')).binding!.automationHold).toBe(
          false,
        );
      }
    },
  );
  it('treats crash after send intent as unknown and holds later automation', async () => {
    await optIn();
    await deliver(change({ 'apps/wiki/config/a': 'a' }));
    await h.container.worker.runOnce();
    await h.container.worker.runOnce();
    const j = (await h.container.repos.jobs.claimNext('lost-worker', h.clock.now(), 1000, [
      'deployment_trigger',
    ]))!;
    await h.container.repos.deployments.begin(j.payload.attemptId as string, 'lost-worker', h.clock.now());
    h.clock.advance(1001);
    await h.container.repos.jobs.reclaimExpired(h.clock.now(), () => 0);
    await drain();
    expect(trigger).not.toHaveBeenCalled();
    expect((await h.container.deployments.history(workspaceId, 'wiki')).attempts[0]!.status).toBe('unknown');
    expect((await h.container.deployments.settings(workspaceId, 'wiki')).binding!.automationHold).toBe(true);
  });
  it('fails closed for nonexistent signed target and force-pushed baseline', async () => {
    await optIn();
    await deliver('f'.repeat(40));
    await drain();
    expect((await decisions())[0]!.reasonCode).toBe('unsafe_history');
    const git = new GitCli({ homeDir: path.join(h.dataDir, 'git-home') });
    const local = (await h.container.repositories.localSource(workspaceId, repositoryId))!;
    await git.run(
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '--allow-empty',
        '-m',
        'unrelated local baseline',
      ],
      { cwd: local.cloneDir },
    );
    const divergent = (await git.run(['rev-parse', 'HEAD'], { cwd: local.cloneDir })).stdout.trim();
    sql('UPDATE deployment_bindings SET routing_head_sha = ? WHERE stack_id = ?', divergent, 'wiki');
    await deliver(change({ 'apps/wiki/config/a': 'a' }));
    await drain();
    expect(trigger).not.toHaveBeenCalled();
    expect((await decisions())[0]!.decision).toBe('blocked');
  });
  it('preview is authenticated, scoped, strict and never sends', async () => {
    const body = { routingPolicy: policy, paths: ['apps/wiki/compose.yaml'] };
    expect((await call(preview.POST, { method: 'POST', params, body })).status).toBe(401);
    expect(
      (
        await call(preview.POST, {
          method: 'POST',
          cookie,
          params: { ...params, workspaceId: 'other' },
          body,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call(preview.POST, {
          method: 'POST',
          cookie,
          params,
          body: { ...body, url: 'https://untrusted' },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(preview.POST, {
          method: 'POST',
          cookie,
          params,
          body: { ...body, routingPolicy: { ...policy, include: ['../**'] } },
        })
      ).status,
    ).toBe(400);
    expect((await call(preview.POST, { method: 'POST', cookie, params, body })).json.decision).toMatchObject({
      relevant: true,
      matchedPaths: ['apps/wiki/compose.yaml'],
    });
    expect(trigger).not.toHaveBeenCalled();
    expect(await decisions()).toEqual([]);
  });
  it('captures a second verified push during an active fetch using its durable follow-up', async () => {
    await optIn();
    const first = change({ 'apps/wiki/config/a': 'a' });
    await deliver(first);
    const provider = h.container.gitProviders.get('github');
    const original = provider.syncClone.bind(provider);
    let second = '';
    vi.spyOn(provider, 'syncClone').mockImplementationOnce(async (input) => {
      const result = await original(input);
      second = change({ 'apps/wiki/config/b': 'b' });
      await deliver(second);
      return result;
    });
    await drain();
    const rows = await decisions();
    expect(rows).toHaveLength(2);
    expect(rows.map((d) => d.afterSha)).toEqual(expect.arrayContaining([first, second]));
    expect((await h.container.repositories.get(workspaceId, repositoryId)).headSha).toBe(second);
    expect(trigger).toHaveBeenCalledTimes(1);
    expect(sql('SELECT * FROM git_webhook_deliveries WHERE processed_at IS NULL')).toEqual([]);
  });
  it('does not route an interrupted fetch and resumes on a successful leased retry', async () => {
    await optIn();
    await deliver(change({ 'apps/wiki/config/a': 'a' }));
    const provider = h.container.gitProviders.get('github');
    vi.spyOn(provider, 'syncClone').mockRejectedValueOnce(new Error('interrupted fetch'));
    await h.container.worker.runOnce();
    expect(await decisions()).toEqual([]);
    expect(trigger).not.toHaveBeenCalled();
    h.clock.advance(6000);
    await drain();
    expect(trigger).toHaveBeenCalledTimes(1);
  });
  it('polling a new HEAD alone never creates routing decisions', async () => {
    await optIn();
    change({ 'apps/wiki/config/a': 'a' });
    await h.container.repos.gitRepositories.update(repositoryId, {
      autoFetchEnabled: true,
      updatedAt: h.clock.now(),
    });
    h.clock.advance(16 * 60 * 1000);
    await h.container.autoFetch.runOnce();
    await drain();
    expect(await decisions()).toEqual([]);
    expect(trigger).not.toHaveBeenCalled();
  });
  it('fences concurrent routing snapshots on the source ledger and checkpoint', async () => {
    await optIn();
    await deliver(change({ 'apps/wiki/config/a': 'a' }));
    await h.container.worker.runOnce();
    const j = (await h.container.repos.jobs.claimNext('route-worker', h.clock.now(), 60000, [
      'deployment_route',
    ]))!;
    const ctx = {
      signal: new AbortController().signal,
      logger: h.container.logger,
      recordAcceptance: async () => true,
    };
    await Promise.all([
      h.container.deploymentRouting.execute(j, ctx),
      h.container.deploymentRouting.execute(j, ctx),
    ]);
    expect(sql('SELECT * FROM deployment_routing_decisions WHERE stack_id = ?', 'wiki')).toHaveLength(1);
    expect(sql('SELECT * FROM deployment_attempts')).toHaveLength(1);
    await h.container.repos.jobs.markSucceeded(j.id, 'route-worker', h.clock.now());
    await drain();
    expect(trigger).toHaveBeenCalledTimes(1);
  });
  it('holds auto routing when a prior terminal job left an uncertain active attempt', async () => {
    await optIn();
    await h.container.deployments.trigger(workspaceId, 'wiki', actor);
    const j = (await h.container.repos.jobs.claimNext('manual-worker', h.clock.now(), 60000, [
      'deployment_trigger',
    ]))!;
    await h.container.repos.jobs.markFailed(j.id, 'manual-worker', h.clock.now(), 'interrupted', 'dead');
    // Routing must recover the stale attempt without requiring a browser to visit history.
    await deliver(change({ 'apps/wiki/config/a': 'a' }));
    await drain();
    expect(trigger).not.toHaveBeenCalled();
    expect((await h.container.deployments.history(workspaceId, 'wiki')).attempts[0]!.status).toBe('unknown');
    expect((await h.container.deployments.settings(workspaceId, 'wiki')).binding!.automationHold).toBe(true);
  });
  it('retains an arrival-time active intent after the earlier request has finished', async () => {
    await optIn();
    await h.container.deployments.trigger(workspaceId, 'wiki', actor);
    await deliver(change({ 'apps/wiki/config/a': 'a' }));
    await drain();
    expect(trigger).toHaveBeenCalledTimes(1);
    expect((await decisions())[0]!).toMatchObject({ decision: 'blocked', reasonCode: 'deployment_active' });
  });
  it('does not clear an unknown hold by removing and recreating a binding', async () => {
    await optIn();
    trigger.mockResolvedValue({ status: 'unknown', httpStatus: null });
    await deliver(change({ 'apps/wiki/config/a': 'a' }));
    await drain();
    const b = (await h.container.deployments.settings(workspaceId, 'wiki')).binding!;
    await h.container.deployments.remove(workspaceId, 'wiki', actor, b.revision);
    await optIn();
    expect((await h.container.deployments.settings(workspaceId, 'wiki')).binding!.automationHold).toBe(true);
    await deliver(change({ 'apps/wiki/config/b': 'b' }));
    await drain();
    expect(trigger).toHaveBeenCalledTimes(1);
  });
  it('invalidates the prior branch baseline immediately when the tracked branch changes', async () => {
    await optIn();
    await h.container.repositories.update(workspaceId, repositoryId, { defaultBranch: 'other' }, actor);
    expect((await h.container.repositories.get(workspaceId, repositoryId)).headSha).toBeNull();
    await expect(optIn()).rejects.toThrow('baseline');
  });
  it('records completion and routing continuation in one transaction', async () => {
    await optIn();
    await deliver(change({ 'apps/wiki/config/a': 'a' }));
    const j = (await h.container.repos.jobs.claimNext('fetch-worker', h.clock.now(), 60000, [
      'repository_sync',
    ]))!;
    await h.container.repositories.sync(repositoryId);
    const next = h.container.jobs.prepare(
      'deployment_route',
      { repositoryId },
      { dedupeKey: `deployment_route:${repositoryId}` },
    );
    expect(await h.container.repos.routing.pending(repositoryId)).toEqual([]);
    expect(
      await h.container.repos.jobs.claimNext('route-worker', h.clock.now(), 60000, ['deployment_route']),
    ).toBeNull();
    sql(
      "CREATE TRIGGER continuation_abort BEFORE INSERT ON jobs WHEN NEW.type = 'deployment_route' BEGIN SELECT RAISE(ABORT, 'crash'); END",
    );
    await expect(
      h.container.repos.jobs.markSucceeded(j.id, 'fetch-worker', h.clock.now(), next),
    ).rejects.toThrow();
    expect((await h.container.repos.jobs.findById(j.id))!.status).toBe('running');
    expect(await h.container.repos.routing.pending(repositoryId)).toEqual([]);
    sql('DROP TRIGGER continuation_abort');
    await h.container.repos.jobs.markSucceeded(j.id, 'fetch-worker', h.clock.now(), next);
    await drain();
    expect(trigger).toHaveBeenCalledTimes(1);
  });
  it('rejects unsigned deliveries and keeps secrets out of logs and history', async () => {
    await optIn();
    await expect(
      h.container.gitWebhooks.receive(workspaceId, repositoryId, new Headers(), Buffer.from('{}')),
    ).rejects.toThrow('authentication');
    await deliver(change({ 'apps/wiki/config/a': 'a' }));
    await drain();
    const visible = JSON.stringify([await h.container.deployments.history(workspaceId, 'wiki'), h.logs]);
    expect(visible).not.toContain(signingSecret);
    expect(visible).not.toContain('hooks.example.test');
    expect(visible).not.toContain('secretNonce');
    expect(trigger).toHaveBeenCalledTimes(1);
  });
});
