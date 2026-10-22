/**
 * v0.6.0 release audit (#57): independent end-to-end checks of selective routing through real Git,
 * SQLite and the durable worker. These cover combinations not exercised by deployment-routing.test.ts.
 */
import { createHmac, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as setup from '@/app/api/setup/route';
import { DEFAULT_ROUTING_POLICY } from '@/shared/deployment-routing';
import { createHarness, type TestHarness } from '../support/container';
import { mockDeploymentSend, sqlRows } from '../support/routing';
import { startGitServer, gitServerOverrides, type GitServer } from '../support/git-server';
import { call } from '../support/http';

let h: TestHarness, server: GitServer, actor: string;
const workspaceId = 'home';
// Random per run: no credential-shaped literals in the repository.
const secrets: Record<string, string> = {};
const trigger = vi.fn();
const policy = { ...DEFAULT_ROUTING_POLICY, dependencies: ['shared/proxy/**', 'shared/ünï cødé/**'] };

const sql = <T = Record<string, unknown>>(statement: string, ...values: unknown[]) =>
  sqlRows<T>(h, statement, ...values);
async function drain() {
  for (let i = 0; i < 40 && (await h.container.worker.runOnce()); i++) {
    /* bounded test drain */
  }
}
async function optIn(stackId: string, deployOnPush = true, enabled = true) {
  const b = (await h.container.deployments.settings(workspaceId, stackId)).binding;
  return h.container.deployments.configure(
    workspaceId,
    stackId,
    {
      providerType: 'generic-webhook',
      enabled,
      expectedRevision: b?.revision ?? null,
      ...(b ? {} : { configuration: { url: `https://hooks.example.test/deploy/${stackId}` } }),
      deployOnPush,
      routingPolicy: policy,
    },
    actor,
  );
}
async function deliver(repositoryId: string, sha: string, id = randomUUID()) {
  const body = JSON.stringify({
    ref: 'refs/heads/main',
    after: sha,
    deleted: false,
    repository: { clone_url: `https://git.test/${repositoryId}.git` },
  });
  const headers = new Headers({
    'x-github-event': 'push',
    'x-github-delivery': id,
    'x-hub-signature-256': `sha256=${createHmac('sha256', secrets[repositoryId]!).update(body).digest('hex')}`,
  });
  return h.container.gitWebhooks.receive(workspaceId, repositoryId, headers, Buffer.from(body));
}
const change = (repo: string, files: Record<string, string | null>) =>
  server.commitFiles(`${repo}.git`, 'main', files);
const decisions = (stackId: string) => h.container.repos.routing.history(workspaceId, stackId);
const attempts = async (stackId: string) =>
  (await h.container.deployments.history(workspaceId, stackId)).attempts;
const binding = async (stackId: string) =>
  (await h.container.deployments.settings(workspaceId, stackId)).binding!;

const mockSend = () => mockDeploymentSend(h, trigger);

async function connect(repositoryId: string) {
  const now = h.clock.now();
  await h.container.repos.gitRepositories.insert({
    id: repositoryId,
    workspaceId,
    name: repositoryId,
    gitProviderType: 'github',
    remoteUrl: `https://git.test/${repositoryId}.git`,
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
  await h.container.gitWebhooks.configure(
    workspaceId,
    repositoryId,
    { secret: secrets[repositoryId]! },
    actor,
  );
}
async function stack(id: string, repositoryId: string, root: string) {
  const now = h.clock.now();
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
}

beforeEach(async () => {
  secrets.infra = `audit-${randomUUID()}`;
  secrets.media = `audit-${randomUUID()}`;
  server = await startGitServer();
  server.createRepo('infra.git');
  server.createRepo('media.git');
  change('infra', {
    'apps/wiki/compose.yaml': 'services: {}',
    'apps/notes/compose.yaml': 'services: {}',
    'apps/wiki café/compose.yaml': 'services: {}',
  });
  change('media', { 'photos/compose.yaml': 'services: {}' });
  h = await createHarness({ overrides: gitServerOverrides(server) });
  const user = await call(setup.POST, {
    method: 'POST',
    body: { username: 'admin', password: 'correct horse battery staple' },
  });
  actor = user.json.user.id;
  const now = h.clock.now();
  await h.container.repos.workspaces.insert({
    id: workspaceId,
    name: 'Home',
    slug: 'audit-home',
    createdAt: now,
    updatedAt: now,
  });
  await connect('infra');
  await connect('media');
  await stack('wiki', 'infra', 'apps/wiki');
  await stack('notes', 'infra', 'apps/notes');
  await stack('cafe', 'infra', 'apps/wiki café');
  await stack('photos', 'media', 'photos');
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

describe('release audit: selective routing matrix', () => {
  it('routes Unicode, spaces and unusual characters through real Git without prefix confusion', async () => {
    await optIn('wiki');
    await optIn('cafe');
    await optIn('notes');
    const sha = change('infra', {
      'apps/wiki café/config/日本 #1 (ü).yml': 'x',
      'shared/ünï cødé/proxy.conf': 'y',
    });
    expect(await deliver('infra', sha)).toBe('accepted');
    await drain();
    // `apps/wiki café` must not match the `apps/wiki` root; the shared dependency matches all three.
    expect((await decisions('cafe'))[0]).toMatchObject({
      decision: 'deploy',
      matchedPaths: ['apps/wiki café/config/日本 #1 (ü).yml', 'shared/ünï cødé/proxy.conf'],
    });
    expect((await decisions('wiki'))[0]!.matchedPaths).toEqual(['shared/ünï cødé/proxy.conf']);
    expect(trigger).toHaveBeenCalledTimes(3);
  });

  it('isolates repositories: a failing fetch in one repository does not block another', async () => {
    await optIn('wiki');
    await optIn('photos');
    const real = h.container.repositories.sync.bind(h.container.repositories);
    vi.spyOn(h.container.repositories, 'sync').mockImplementation(async (id, signal) => {
      if (id === 'infra') throw new Error('simulated network failure');
      return real(id, signal);
    });
    await deliver('infra', change('infra', { 'apps/wiki/config/a': 'a' }));
    await deliver('media', change('media', { 'photos/config/b': 'b' }));
    await drain();
    expect(await attempts('wiki')).toEqual([]);
    expect((await attempts('photos'))[0]).toMatchObject({ status: 'accepted', triggerType: 'automatic' });
    expect(trigger).toHaveBeenCalledTimes(1);
  });

  it('never deploys when a verified delivery’s fetch exhausts retries, even after a later polled fetch', async () => {
    await optIn('wiki');
    const baseline = (await binding('wiki')).routingHeadSha;
    const real = h.container.repositories.sync.bind(h.container.repositories);
    const sync = vi
      .spyOn(h.container.repositories, 'sync')
      .mockRejectedValue(new Error('simulated forge outage'));
    const first = change('infra', { 'apps/wiki/config/a': 'a' });
    await deliver('infra', first);
    for (let i = 0; i < 8; i++) {
      await drain();
      h.clock.advance(16 * 60_000);
    }
    expect(sql<{ status: string }>("SELECT status FROM jobs WHERE type = 'repository_sync'")).toEqual([
      { status: 'dead' },
    ]);
    sync.mockImplementation((id, signal) => real(id, signal));
    // Polling/manual fetch alone grants no deployment authority, so the orphaned source stays unrouted.
    await h.container.repositories.requestSync(workspaceId, 'infra', actor);
    await drain();
    expect(trigger).not.toHaveBeenCalled();
    expect(await decisions('wiki')).toEqual([]);
    expect((await binding('wiki')).routingHeadSha).toBe(baseline);
    // The next verified push covers the earlier change because the cursor never advanced.
    h.clock.advance(1000);
    await deliver('infra', change('infra', { 'apps/wiki/config/b': 'b' }));
    await drain();
    expect((await decisions('wiki'))[0]).toMatchObject({
      decision: 'deploy',
      matchedPaths: ['apps/wiki/config/a', 'apps/wiki/config/b'],
    });
    expect(trigger).toHaveBeenCalledTimes(1);
  });

  it('blocks a source signed before rotation without advancing the cursor; the next push covers it', async () => {
    await optIn('wiki');
    const before = (await binding('wiki')).routingHeadSha;
    await deliver('infra', change('infra', { 'apps/wiki/config/a': 'a' }));
    await h.container.gitWebhooks.configure(
      workspaceId,
      'infra',
      { secret: (secrets.infra = `audit-${randomUUID()}`) },
      actor,
    );
    await drain();
    expect((await decisions('wiki'))[0]).toMatchObject({
      decision: 'blocked',
      reasonCode: 'signing_changed',
    });
    expect((await binding('wiki')).routingHeadSha).toBe(before);
    expect(trigger).not.toHaveBeenCalled();
    h.clock.advance(1000);
    await deliver('infra', change('infra', { 'apps/wiki/config/b': 'b' }));
    await drain();
    expect((await decisions('wiki'))[0]).toMatchObject({
      decision: 'deploy',
      matchedPaths: ['apps/wiki/config/a', 'apps/wiki/config/b'],
    });
    expect(trigger).toHaveBeenCalledTimes(1);
  });

  it('rejects queued automatic work after deployment credential rotation or disabling, without sending', async () => {
    await optIn('wiki');
    await optIn('notes');
    await deliver('infra', change('infra', { 'apps/wiki/config/a': 'a', 'apps/notes/config/a': 'a' }));
    await h.container.worker.runOnce(); // fetch
    await h.container.worker.runOnce(); // route: both attempts queued
    expect((await attempts('wiki'))[0]!.status).toBe('queued');
    const wiki = await binding('wiki');
    await h.container.deployments.configure(
      workspaceId,
      'wiki',
      {
        providerType: 'generic-webhook',
        enabled: true,
        expectedRevision: wiki.revision,
        configuration: { url: 'https://hooks.example.test/deploy/rotated' },
        deployOnPush: true,
        routingPolicy: policy,
      },
      actor,
    );
    await optIn('notes', false, false);
    await drain();
    expect(trigger).not.toHaveBeenCalled();
    expect((await attempts('wiki'))[0]!.status).toBe('rejected');
    expect((await attempts('notes'))[0]!.status).toBe('rejected');
  });

  it('turning automatic deployment off stops later pushes; turning it on re-baselines without replay', async () => {
    await optIn('wiki');
    await optIn('wiki', false);
    await deliver('infra', change('infra', { 'apps/wiki/config/a': 'a' }));
    await drain();
    expect((await decisions('wiki'))[0]!.reasonCode).toBe('deploy_on_push_disabled');
    h.clock.advance(1000);
    await optIn('wiki');
    expect((await binding('wiki')).routingHeadSha).toBe(
      (await h.container.repos.gitRepositories.findById(workspaceId, 'infra'))!.headSha,
    );
    await drain();
    expect(trigger).not.toHaveBeenCalled();
  });

  it('holds automation after an unknown provider outcome until a deliberate manual request', async () => {
    await optIn('wiki');
    trigger.mockResolvedValueOnce({ status: 'unknown', reason: 'request_failed' });
    await deliver('infra', change('infra', { 'apps/wiki/config/a': 'a' }));
    await drain();
    expect((await attempts('wiki'))[0]!.status).toBe('unknown');
    expect((await binding('wiki')).automationHold).toBe(true);
    h.clock.advance(1000);
    await deliver('infra', change('infra', { 'apps/wiki/config/b': 'b' }));
    await drain();
    expect((await decisions('wiki'))[0]).toMatchObject({
      decision: 'blocked',
      reasonCode: 'outcome_unknown',
    });
    expect(trigger).toHaveBeenCalledTimes(1);
    // Re-saving settings does not clear the hold.
    await optIn('wiki');
    expect((await binding('wiki')).automationHold).toBe(true);
    await h.container.deployments.trigger(workspaceId, 'wiki', actor);
    await drain();
    expect((await binding('wiki')).automationHold).toBe(false);
    h.clock.advance(1000);
    await deliver('infra', change('infra', { 'apps/wiki/config/c': 'c' }));
    await drain();
    expect((await decisions('wiki'))[0]!.decision).toBe('deploy');
    expect(trigger).toHaveBeenCalledTimes(3);
    expect(sql("SELECT count(*) AS n FROM deployment_attempts WHERE status = 'unknown'")).toEqual([{ n: 1 }]);
  });

  it('never routes a verified push for another workspace’s repository identifier', async () => {
    await optIn('wiki');
    const sha = change('infra', { 'apps/wiki/config/a': 'a' });
    const body = JSON.stringify({
      ref: 'refs/heads/main',
      after: sha,
      deleted: false,
      repository: { clone_url: 'https://git.test/infra.git' },
    });
    const headers = new Headers({
      'x-github-event': 'push',
      'x-github-delivery': randomUUID(),
      'x-hub-signature-256': `sha256=${createHmac('sha256', secrets.infra!).update(body).digest('hex')}`,
    });
    await expect(
      h.container.gitWebhooks.receive('other-workspace', 'infra', headers, Buffer.from(body)),
    ).rejects.toThrow('Webhook authentication failed.');
    await drain();
    expect(trigger).not.toHaveBeenCalled();
  });
});
