import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuditEvent } from '@/server/domain/audit';
import { createHarness, type TestHarness } from '../support/container';

let h: TestHarness;

beforeEach(async () => {
  h = await createHarness();
  const at = h.clock.now();
  await h.container.repos.workspaces.insert({
    id: 'workspace-one',
    name: 'One',
    slug: 'one',
    createdAt: at,
    updatedAt: at,
  });
  await h.container.repos.workspaces.insert({
    id: 'workspace-two',
    name: 'Two',
    slug: 'two',
    createdAt: at,
    updatedAt: at,
  });
});

afterEach(async () => h.cleanup());

describe('dashboard activity query', () => {
  it('filters routine successful events before LIMIT, retaining old meaningful events and failures', async () => {
    const base = h.clock.now().getTime();
    const events: AuditEvent[] = [
      {
        id: 'old-push',
        workspaceId: 'workspace-one',
        createdAt: new Date(base),
        actorUserId: null,
        action: 'git.push',
        outcome: 'success',
        entityType: 'repository',
        entityId: null,
        meta: {},
      },
      {
        id: 'old-failed-test',
        workspaceId: 'workspace-one',
        createdAt: new Date(base + 1),
        actorUserId: null,
        action: 'repository.test',
        outcome: 'failure',
        entityType: 'repository',
        entityId: null,
        meta: {},
      },
      {
        id: 'other-workspace',
        workspaceId: 'workspace-two',
        createdAt: new Date(base + 2000),
        actorUserId: null,
        action: 'git.push',
        outcome: 'success',
        entityType: 'repository',
        entityId: null,
        meta: {},
      },
    ];
    for (let index = 0; index < 75; index++) {
      events.push({
        id: `routine-${index}`,
        workspaceId: 'workspace-one',
        createdAt: new Date(base + index + 2),
        actorUserId: null,
        action: index % 2 ? 'auth.login' : 'repository.sync_requested',
        outcome: 'success',
        entityType: null,
        entityId: null,
        meta: {},
      });
    }
    for (const event of events) await h.container.repos.audit.insert(event);
    const result = await h.container.audit.list({
      workspaceId: 'workspace-one',
      limit: 5,
      excludeSuccessfulActions: [
        'auth.login',
        'repository.sync_requested',
        'repository.test',
      ],
    });
    expect(result.map((event) => event.id)).toEqual(['old-failed-test', 'old-push']);
    const fullAudit = await h.container.audit.list({ workspaceId: 'workspace-one', limit: 100 });
    expect(fullAudit).toHaveLength(77);
  });

  it('returns the five latest meaningful results even after a long burst of routine events', async () => {
    const base = h.clock.now().getTime();
    for (let i = 0; i < 5; i++) {
      await h.container.repos.audit.insert({
        id: `meaningful-${i}`,
        workspaceId: 'workspace-one',
        createdAt: new Date(base + i),
        actorUserId: null,
        action: 'draft.save',
        outcome: 'success',
        entityType: 'stack',
        entityId: null,
        meta: {},
      });
    }
    for (let i = 0; i < 50; i++) {
      await h.container.repos.audit.insert({
        id: `routine-${i}`,
        workspaceId: 'workspace-one',
        createdAt: new Date(base + 10 + i),
        actorUserId: null,
        action: 'auth.login',
        outcome: 'success',
        entityType: null,
        entityId: null,
        meta: {},
      });
    }
    const result = await h.container.audit.list({
      workspaceId: 'workspace-one',
      limit: 5,
      excludeSuccessfulActions: ['auth.login'],
    });
    expect(result.map((event) => event.id)).toEqual([
      'meaningful-4',
      'meaningful-3',
      'meaningful-2',
      'meaningful-1',
      'meaningful-0',
    ]);
  });
});
