import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as setup from '@/app/api/setup/route';
import { DeploymentService } from '@/server/application/deployment-service';
import { JobQueue } from '@/server/application/job-queue';
import { openSqlite } from '@/server/persistence/sqlite/database';
import { createSqliteRepositories } from '@/server/persistence/sqlite/repositories';
import type { DeploymentProvider } from '@/server/providers/deployment/types';
import { createHarness, type TestHarness } from '../support/container';
import { call } from '../support/http';

const URL = 'https://deploy.example.test/api/stacks/webhooks/synthetic-secret-token';
let h: TestHarness;
let service: DeploymentService;
let actor: string;
const workspaceId = 'workspace',
  stackId = 'stack';
const trigger = vi.fn();
beforeEach(async () => {
  h = await createHarness();
  actor = (
    await call(setup.POST, {
      method: 'POST',
      body: { username: 'admin', password: 'correct horse battery staple' },
    })
  ).json.user.id;
  const now = h.clock.now();
  await h.container.repos.workspaces.insert({
    id: workspaceId,
    name: 'Home',
    slug: 'home',
    createdAt: now,
    updatedAt: now,
  });
  await h.container.repos.gitRepositories.insert({
    id: 'repository',
    workspaceId,
    name: 'Repo',
    gitProviderType: 'github',
    remoteUrl: 'https://github.com/example/repo.git',
    defaultBranch: 'main',
    credentialId: null,
    webhookCredentialId: null,
    localClonePath: 'repos/repository',
    syncStatus: 'ready',
    lastSyncError: null,
    headSha: null,
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
  await h.container.repos.stacks.insert({
    id: stackId,
    workspaceId,
    repositoryId: 'repository',
    name: 'Stack',
    slug: 'stack',
    rootPath: '',
    composePath: 'compose.yaml',
    createdAt: now,
    updatedAt: now,
  });
  trigger.mockReset().mockResolvedValue({ status: 'accepted', httpStatus: 204 });
  const provider: DeploymentProvider = {
    type: 'portainer-webhook',
    validateConfiguration: (v) => v as { url: string },
    validateDestination: async () => {},
    trigger,
  };
  service = new DeploymentService(
    h.container.repos,
    h.container.credentials,
    new Map([
      ['portainer-webhook', provider],
      ['generic-webhook', { ...provider, type: 'generic-webhook' }],
    ]),
    h.container.jobs,
    h.container.audit,
    h.clock,
    randomUUID,
  );
});
afterEach(async () => h.cleanup());
async function configure(extra: Record<string, unknown> = {}) {
  return service.configure(
    workspaceId,
    stackId,
    {
      providerType: 'portainer-webhook',
      enabled: true,
      expectedRevision: null,
      configuration: { url: URL },
      ...extra,
    },
    actor,
  );
}
async function execute() {
  const j = await h.container.repos.jobs.claimNext('test-worker', h.clock.now(), 60000, [
    'deployment_trigger',
  ]);
  expect(j).not.toBeNull();
  await service.execute(j!, {
    signal: new AbortController().signal,
    logger: h.container.logger,
    recordAcceptance: () => h.container.repos.jobs.recordAcceptance(j!.id, 'test-worker', h.clock.now()),
  });
  await h.container.repos.jobs.markSucceeded(j!.id, 'test-worker', h.clock.now());
  return j!;
}
describe('per-stack deployment bindings', () => {
  it('encrypts full configuration, masks responses, retains revisions and prevents referenced credential deletion', async () => {
    const result = await configure();
    expect(result.binding).toMatchObject({ enabled: true, deployOnPush: false, hint: '••••' });
    expect(JSON.stringify(result)).not.toContain(URL);
    const c = await h.container.credentials.get(workspaceId, result.binding!.credentialId);
    expect(c).toMatchObject({ hint: '••••', meta: {} });
    await expect(h.container.credentials.delete(workspaceId, c.id, actor)).rejects.toThrow('in use');
    const files = [h.config.databasePath, `${h.config.databasePath}-wal`].filter(fs.existsSync);
    expect(Buffer.concat(files.map((f) => fs.readFileSync(f))).toString()).not.toContain(URL);
    expect(h.logs.join('')).not.toContain(URL);
    expect((await service.settings(workspaceId, stackId)).binding?.revision).toBe(result.binding?.revision);
  });
  it('atomic concurrent creation and CAS updates do not leave losing credentials', async () => {
    const results = await Promise.allSettled([configure(), configure()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await h.container.repos.credentials.list(workspaceId)).toHaveLength(1);
    const b = (await service.settings(workspaceId, stackId)).binding!;
    const updates = await Promise.allSettled([
      configure({ expectedRevision: b.revision }),
      configure({ expectedRevision: b.revision }),
    ]);
    expect(updates.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await h.container.repos.credentials.list(workspaceId)).toHaveLength(1);
  });
  it('rejects wrong workspace, kinds, provider and malformed generic credential rotations', async () => {
    await expect(service.settings('other', stackId)).rejects.toThrow('Stack not found');
    const c = await h.container.credentials.create(
      { workspaceId, kind: 'git', providerType: 'github', label: 'Git', secret: 'synthetic-test-pat' },
      actor,
    );
    await expect(configure({ configuration: undefined, credentialId: c.id })).rejects.toThrow(
      'does not match',
    );
    const b = (await configure()).binding!;
    await expect(
      h.container.credentials.replaceSecret(
        workspaceId,
        b.credentialId,
        'https://plain.example.test/token',
        actor,
      ),
    ).rejects.toThrow('Invalid deployment configuration');
    await expect(
      h.container.credentials.update(workspaceId, b.credentialId, { meta: { host: URL } }, actor),
    ).rejects.toThrow('do not support metadata');
  });
  it('serializes duplicate requests and records acceptance without reporting health', async () => {
    await configure();
    const results = await Promise.allSettled([
      service.trigger(workspaceId, stackId, actor),
      service.trigger(workspaceId, stackId, actor),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    await execute();
    expect(trigger).toHaveBeenCalledTimes(1);
    const history = await service.history(workspaceId, stackId);
    expect(history.attempts[0]).toMatchObject({ status: 'accepted', httpStatus: 204 });
    expect(JSON.stringify(history)).not.toMatch(/credentialNonce|bindingRevision|https:/);
    expect(await h.container.worker.runOnce()).toBe(false);
  });
  it.each([
    { status: 'rejected', httpStatus: 403 },
    { status: 'rejected', httpStatus: null },
    { status: 'unknown', reason: 'request_timeout_or_cancelled' },
  ])('records $status without automatic retry', async (result) => {
    await configure();
    trigger.mockResolvedValue(result);
    await service.trigger(workspaceId, stackId, actor);
    await execute();
    expect((await service.history(workspaceId, stackId)).attempts[0]!.status).toBe(result.status);
    expect(await h.container.worker.runOnce()).toBe(false);
    expect(trigger).toHaveBeenCalledTimes(1);
  });
  it.each(['disable', 'rotate', 'remove'])('does not send after %s before execution', async (operation) => {
    const b = (await configure()).binding!;
    await service.trigger(workspaceId, stackId, actor);
    if (operation === 'remove') await service.remove(workspaceId, stackId, actor, b.revision);
    else if (operation === 'disable')
      await configure({ expectedRevision: b.revision, enabled: false, configuration: undefined });
    else
      await h.container.credentials.replaceSecret(
        workspaceId,
        b.credentialId,
        JSON.stringify({ url: URL + '/rotated' }),
        actor,
      );
    await execute();
    expect(trigger).not.toHaveBeenCalled();
    expect((await service.history(workspaceId, stackId)).attempts[0]!.status).toBe('rejected');
  });
  it('recovers persisted running intent as unknown after restart without sending again', async () => {
    await configure();
    const requested = await service.trigger(workspaceId, stackId, actor);
    await h.container.repos.jobs.claimNext('crashed', h.clock.now(), 1000, ['deployment_trigger']);
    expect(await h.container.repos.deployments.begin(requested.attempt.id, 'crashed', h.clock.now())).toBe(
      true,
    );
    h.clock.advance(1001);
    await h.container.repos.jobs.reclaimExpired(h.clock.now(), () => 0);
    await execute();
    expect(trigger).not.toHaveBeenCalled();
    expect((await service.history(workspaceId, stackId)).attempts[0]!.status).toBe('unknown');
  });
  it('persists recovery despite an isolated audit storage failure', async () => {
    await configure();
    const requested = await service.trigger(workspaceId, stackId, actor);
    await h.container.repos.jobs.claimNext('crashed', h.clock.now(), 1000, ['deployment_trigger']);
    await h.container.repos.deployments.begin(requested.attempt.id, 'crashed', h.clock.now());
    h.clock.advance(1001);
    await h.container.repos.jobs.reclaimExpired(h.clock.now(), () => 0);
    const insert = vi
      .spyOn(h.container.repos.audit, 'insert')
      .mockRejectedValue(new Error('audit storage unavailable'));
    try {
      await execute();
      expect((await service.history(workspaceId, stackId)).attempts[0]!.status).toBe('unknown');
      expect(h.logs.join('')).toContain('audit write failed');
      expect(trigger).not.toHaveBeenCalled();
    } finally {
      insert.mockRestore();
    }
  });
  it('cleans bindings and attempts when stack is deleted', async () => {
    await configure();
    await service.trigger(workspaceId, stackId, actor);
    await h.container.repos.stacks.delete(stackId);
    expect(await h.container.repos.deployments.binding(workspaceId, stackId)).toBeNull();
    expect(await h.container.repos.deployments.history(workspaceId, stackId)).toEqual([]);
    await execute();
    expect(trigger).not.toHaveBeenCalled();
  });
  it('retains externally attached credentials when removing a binding', async () => {
    const c = await h.container.credentials.create(
      {
        workspaceId,
        kind: 'deployment',
        providerType: 'portainer-webhook',
        label: 'Shared destination',
        secret: JSON.stringify({ url: URL }),
      },
      actor,
    );
    const b = (await configure({ configuration: undefined, credentialId: c.id })).binding!;
    await service.remove(workspaceId, stackId, actor, b.revision);
    expect(await h.container.repos.credentials.findById(workspaceId, c.id)).not.toBeNull();
  });
  it('cleans managed credentials on rotation, removal and stack cascade', async () => {
    const first = (await configure()).binding!;
    const second = (await configure({ expectedRevision: first.revision })).binding!;
    expect(await h.container.repos.credentials.findById(workspaceId, first.credentialId)).toBeNull();
    await service.remove(workspaceId, stackId, actor, second.revision);
    expect(await h.container.repos.credentials.list(workspaceId)).toEqual([]);
    await configure();
    await h.container.repos.stacks.delete(stackId);
    expect(await h.container.repos.credentials.list(workspaceId)).toEqual([]);
  });
  it('rejects a missing or incompatible deployment credential and automatic deployment preference', async () => {
    await expect(configure({ configuration: undefined, credentialId: 'missing' })).rejects.toThrow(
      'Credential not found',
    );
    const generic = await h.container.credentials.create(
      {
        workspaceId,
        kind: 'deployment',
        providerType: 'generic-webhook',
        label: 'Generic',
        secret: JSON.stringify({ url: URL }),
      },
      actor,
    );
    await expect(configure({ configuration: undefined, credentialId: generic.id })).rejects.toThrow(
      'does not match',
    );
    await expect(configure({ deployOnPush: true })).rejects.toThrow('Invalid deployment settings');
  });
  it('fences late completion after another worker acquires the expired lease', async () => {
    await configure();
    const requested = await service.trigger(workspaceId, stackId, actor);
    const j = await h.container.repos.jobs.claimNext('old', h.clock.now(), 1000, ['deployment_trigger']);
    expect(j).not.toBeNull();
    await h.container.repos.deployments.begin(requested.attempt.id, 'old', h.clock.now());
    h.clock.advance(1001);
    await h.container.repos.jobs.reclaimExpired(h.clock.now(), () => 0);
    await h.container.repos.jobs.claimNext('new', h.clock.now(), 60000, ['deployment_trigger']);
    expect(
      await h.container.repos.deployments.finish(
        requested.attempt.id,
        'old',
        { status: 'accepted', httpStatus: 204, reason: null },
        h.clock.now(),
      ),
    ).toBe(false);
    expect((await service.history(workspaceId, stackId)).attempts[0]!.status).toBe('running');
    await expect(service.trigger(workspaceId, stackId, actor)).rejects.toThrow('already active');
  });
  it('never resends known HTTP acceptance after worker interruption', async () => {
    await configure();
    const requested = await service.trigger(workspaceId, stackId, actor);
    const j = await h.container.repos.jobs.claimNext('crashed', h.clock.now(), 1000, ['deployment_trigger']);
    await h.container.repos.deployments.begin(requested.attempt.id, 'crashed', h.clock.now());
    await h.container.repos.deployments.finish(
      requested.attempt.id,
      'crashed',
      { status: 'accepted', httpStatus: 204, reason: null },
      h.clock.now(),
    );
    await h.container.repos.jobs.recordAcceptance(j!.id, 'crashed', h.clock.now());
    h.clock.advance(1001);
    await h.container.repos.jobs.reclaimExpired(h.clock.now(), () => 0);
    expect((await service.history(workspaceId, stackId)).attempts[0]!.status).toBe('accepted');
    // Recovery may complete the job directly when acceptanceRecordedAt is already durable.
    const recovered = await h.container.repos.jobs.findById(j!.id);
    if (recovered?.status === 'pending') await execute();
    expect(trigger).not.toHaveBeenCalled();
  });
  it('rejects a disabled actor before execution and audits the failure timestamp', async () => {
    await configure();
    await service.trigger(workspaceId, stackId, actor);
    const db = openSqlite(h.config.databasePath);
    try {
      db.db.$client
        .prepare('UPDATE users SET disabled_at = ? WHERE id = ?')
        .run(h.clock.now().getTime(), actor);
    } finally {
      db.close();
    }
    await execute();
    expect(trigger).not.toHaveBeenCalled();
    expect((await service.history(workspaceId, stackId)).attempts[0]!.status).toBe('rejected');
    expect((await service.settings(workspaceId, stackId)).binding?.lastFailedAt).not.toBeNull();
    expect(
      (await h.container.repos.audit.list({ workspaceId, limit: 100 })).some(
        (a) => a.action === 'deployment.rejected',
      ),
    ).toBe(true);
  });
  it('does not attach credentials owned by a different workspace', async () => {
    const now = h.clock.now();
    await h.container.repos.workspaces.insert({
      id: 'other-workspace',
      name: 'Other',
      slug: 'other',
      createdAt: now,
      updatedAt: now,
    });
    const c = await h.container.credentials.create(
      {
        workspaceId: 'other-workspace',
        kind: 'deployment',
        providerType: 'portainer-webhook',
        label: 'Other',
        secret: JSON.stringify({ url: URL }),
      },
      actor,
    );
    await expect(configure({ configuration: undefined, credentialId: c.id })).rejects.toThrow(
      'Credential not found',
    );
    expect((await service.settings(workspaceId, stackId)).binding).toBeNull();
  });
  it('cleans a managed credential after its original and final shared binding are removed', async () => {
    const first = (await configure()).binding!;
    const now = h.clock.now();
    await h.container.repos.stacks.insert({
      id: 'second-stack',
      workspaceId,
      repositoryId: 'repository',
      name: 'Second',
      slug: 'second',
      rootPath: 'second',
      composePath: 'second/compose.yaml',
      createdAt: now,
      updatedAt: now,
    });
    const second = (
      await service.configure(
        workspaceId,
        'second-stack',
        {
          providerType: 'portainer-webhook',
          enabled: true,
          expectedRevision: null,
          credentialId: first.credentialId,
        },
        actor,
      )
    ).binding!;
    await service.remove(workspaceId, stackId, actor, first.revision);
    expect(await h.container.repos.credentials.findById(workspaceId, first.credentialId)).not.toBeNull();
    await service.remove(workspaceId, 'second-stack', actor, second.revision);
    expect(await h.container.repos.credentials.findById(workspaceId, first.credentialId)).toBeNull();
  });
  it('can disable existing binding during a destination DNS outage', async () => {
    const b = (await configure()).binding!;
    const unavailable = {
      type: 'portainer-webhook' as const,
      validateConfiguration: (v: unknown) => v as { url: string },
      validateDestination: vi.fn().mockRejectedValue(new Error('DNS unavailable')),
      trigger,
    };
    const outage = new DeploymentService(
      h.container.repos,
      h.container.credentials,
      new Map([['portainer-webhook', unavailable]]),
      h.container.jobs,
      h.container.audit,
      h.clock,
      randomUUID,
    );
    expect(
      (
        await outage.configure(
          workspaceId,
          stackId,
          { providerType: 'portainer-webhook', enabled: false, expectedRevision: b.revision },
          actor,
        )
      ).binding?.enabled,
    ).toBe(false);
    expect(unavailable.validateDestination).not.toHaveBeenCalled();
  });
  it.each(['accepted', 'rejected'] as const)(
    'preserves newer %s attempt timestamps during a configuration save',
    async (status) => {
      const initial = (await configure()).binding!;
      const originalSave = h.container.repos.deployments.save.bind(h.container.repos.deployments);
      const save = vi.spyOn(h.container.repos.deployments, 'save').mockImplementationOnce(async (...args) => {
        h.clock.advance(1000);
        trigger.mockResolvedValue({ status, httpStatus: status === 'accepted' ? 204 : 403 });
        await service.trigger(workspaceId, stackId, actor);
        await execute();
        return originalSave(...args);
      });
      const result = await configure({ expectedRevision: initial.revision });
      expect(result.binding?.lastAttemptAt).toBe(h.clock.now().toISOString());
      expect(status === 'accepted' ? result.binding?.lastAcceptedAt : result.binding?.lastFailedAt).toBe(
        h.clock.now().toISOString(),
      );
      save.mockRestore();
    },
  );
  it('serializes independent SQLite connections and retains binding state after reopen', async () => {
    const handle = openSqlite(h.config.databasePath);
    try {
      const repos = createSqliteRepositories(handle.db);
      const provider: DeploymentProvider = {
        type: 'portainer-webhook',
        validateConfiguration: (value) => value as { url: string },
        validateDestination: async () => {},
        trigger,
      };
      const other = new DeploymentService(
        repos,
        h.container.credentials,
        new Map([['portainer-webhook', provider]]),
        new JobQueue(repos.jobs, h.clock, randomUUID),
        h.container.audit,
        h.clock,
        randomUUID,
      );
      const results = await Promise.allSettled([
        configure(),
        other.configure(
          workspaceId,
          stackId,
          {
            providerType: 'portainer-webhook',
            enabled: true,
            expectedRevision: null,
            configuration: { url: URL },
          },
          actor,
        ),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(await repos.credentials.list(workspaceId)).toHaveLength(1);
      const requests = await Promise.allSettled([
        service.trigger(workspaceId, stackId, actor),
        other.trigger(workspaceId, stackId, actor),
      ]);
      expect(requests.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(await repos.deployments.history(workspaceId, stackId)).toHaveLength(1);
    } finally {
      handle.close();
    }
    const reopened = openSqlite(h.config.databasePath);
    try {
      const repos = createSqliteRepositories(reopened.db);
      expect(await repos.deployments.binding(workspaceId, stackId)).toMatchObject({
        enabled: true,
        deployOnPush: false,
      });
      expect(await repos.deployments.history(workspaceId, stackId)).toHaveLength(1);
    } finally {
      reopened.close();
    }
  });
  it.each(['ok', 'failed'] as const)(
    'records safe non-sending destination validation: %s',
    async (status) => {
      const binding = (await configure({ enabled: false })).binding!;
      const validateDestination = vi.fn(async () => {
        if (status === 'failed') throw new Error(URL);
      });
      const provider: DeploymentProvider = {
        type: 'portainer-webhook',
        validateConfiguration: (v) => v as { url: string },
        validateDestination,
        trigger,
      };
      const validating = new DeploymentService(
        h.container.repos,
        h.container.credentials,
        new Map([['portainer-webhook', provider]]),
        h.container.jobs,
        h.container.audit,
        h.clock,
        randomUUID,
      );
      const result = await validating.test(workspaceId, stackId, actor);
      expect(result.binding).toMatchObject({
        enabled: false,
        lastTestStatus: status,
        lastTestedAt: h.clock.now().toISOString(),
      });
      expect(result.binding?.lastTestMessage).toContain(
        'No webhook sent; TLS and HTTP response were not tested.',
      );
      expect(JSON.stringify(result)).not.toContain(URL);
      expect(trigger).not.toHaveBeenCalled();
      expect(validateDestination).toHaveBeenCalledTimes(1);
      expect((await service.settings(workspaceId, stackId)).binding?.lastTestStatus).toBe(status);
      expect(result.binding?.revision).toBe(binding.revision);
      const events = await h.container.audit.list({ workspaceId, limit: 100 });
      expect(events.filter((event) => event.action === 'deployment.destination_validated')).toEqual([
        expect.objectContaining({
          outcome: status === 'ok' ? 'success' : 'failure',
          actorUserId: actor,
          entityType: 'stack',
          entityId: stackId,
          meta: { destinationValidation: status },
        }),
      ]);
      expect(events.some((event) => event.action === 'deployment.binding_updated')).toBe(false);
      expect(JSON.stringify(events)).not.toContain(URL);
    },
  );
  it.each(['rotation', 'removal', 'binding-update'] as const)(
    'fences destination validation against concurrent %s',
    async (change) => {
      const binding = (await configure()).binding!;
      const validateDestination = async () => {
        if (change === 'rotation')
          await h.container.credentials.replaceSecret(
            workspaceId,
            binding.credentialId,
            JSON.stringify({ url: URL + '/rotated' }),
            actor,
          );
        else if (change === 'removal') await service.remove(workspaceId, stackId, actor, binding.revision);
        else
          await configure({ expectedRevision: binding.revision, configuration: undefined, enabled: false });
      };
      const provider: DeploymentProvider = {
        type: 'portainer-webhook',
        validateConfiguration: (v) => v as { url: string },
        validateDestination,
        trigger,
      };
      const validating = new DeploymentService(
        h.container.repos,
        h.container.credentials,
        new Map([['portainer-webhook', provider]]),
        h.container.jobs,
        h.container.audit,
        h.clock,
        randomUUID,
      );
      await expect(validating.test(workspaceId, stackId, actor)).rejects.toThrow(
        'changed during destination validation',
      );
      expect((await service.settings(workspaceId, stackId)).binding?.lastTestStatus ?? null).toBeNull();
      expect(trigger).not.toHaveBeenCalled();
    },
  );
  it('rejects destination validation without a binding or in another workspace', async () => {
    await expect(service.test(workspaceId, stackId, actor)).rejects.toThrow('Deployment binding not found');
    await configure();
    await expect(service.test('other-workspace', stackId, actor)).rejects.toThrow('Stack not found');
    expect(trigger).not.toHaveBeenCalled();
  });
  it('clears stored destination validation when the credential rotates', async () => {
    const binding = (await configure()).binding!;
    await service.test(workspaceId, stackId, actor);
    expect((await service.settings(workspaceId, stackId)).binding?.lastTestStatus).toBe('ok');
    await h.container.credentials.replaceSecret(
      workspaceId,
      binding.credentialId,
      JSON.stringify({ url: URL + '/rotated' }),
      actor,
    );
    expect((await service.settings(workspaceId, stackId)).binding).toMatchObject({
      lastTestedAt: null,
      lastTestStatus: null,
      lastTestMessage: null,
    });
  });
});
