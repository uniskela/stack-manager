import { describe, expect, it } from 'vitest';
import {
  dashboardNextStep,
  dashboardRecentActivity,
  dashboardSyncSummary,
  dashboardWork,
  type DashboardRepository,
} from '@/shared/dashboard/overview';

const repos: DashboardRepository[] = [
  {
    id: 'r1',
    name: 'Infrastructure',
    syncStatus: 'ready',
    lastSyncError: null,
    lastSyncAttemptAt: '2026-10-20T10:20:00.000Z',
    lastFetchedAt: '2026-10-20T10:19:00.000Z',
  },
  {
    id: 'r2',
    name: 'Backup',
    syncStatus: 'error',
    lastSyncError: 'Could not fetch remote.',
    lastSyncAttemptAt: '2026-10-20T09:20:00.000Z',
    lastFetchedAt: null,
  },
];

describe('dashboardSyncSummary', () => {
  it('shows source sync counts and latest attempt, not container health', () => {
    expect(dashboardSyncSummary(repos)).toEqual({
      ready: 1,
      pending: 0,
      syncing: 0,
      error: 1,
      latestAttempt: '2026-10-20T10:20:00.000Z',
    });
  });

  it('handles pending, running and unfetched repositories', () => {
    const result = dashboardSyncSummary([
      { ...repos[0]!, syncStatus: 'pending', lastSyncAttemptAt: null, lastFetchedAt: null },
      { ...repos[1]!, syncStatus: 'syncing', lastSyncAttemptAt: null },
    ]);
    expect(result).toMatchObject({ pending: 1, syncing: 1, latestAttempt: null });
  });
});

describe('dashboardWork', () => {
  const stacks = [
    { id: 's1', name: 'whatsupdocker', repository: { id: 'r1' } },
    { id: 's2', name: 'traefik', repository: { id: 'r1' } },
    { id: 's3', name: 'backup', repository: { id: 'r2' } },
  ];

  it('groups the same stack’s draft and outdated files into one attention row', () => {
    const result = dashboardWork(
      repos,
      stacks,
      [2, 3, 0],
      [
        { repositoryId: 'r1', path: 'whatsupdocker/compose.yml', stackId: 's1' },
        { repositoryId: 'r1', path: 'whatsupdocker/compose.yml', stackId: 's1' },
      ],
    );
    expect(result.attention).toEqual([
      {
        key: 'sync-r2',
        kind: 'sync-error',
        label: 'Backup',
        detail: 'Could not fetch remote.',
        target: { type: 'repository', id: 'r2' },
      },
      {
        key: 'outdated-stack-s1',
        kind: 'outdated',
        label: 'whatsupdocker',
        detail: '1 outdated draft · 2 open drafts',
        target: { type: 'stack', id: 's1' },
      },
    ]);
    expect(result.draftsInProgress).toEqual([{ id: 's2', label: 'traefik', draftCount: 3 }]);
  });

  it('groups different outdated paths outside a stack by repository', () => {
    const result = dashboardWork(
      repos,
      [],
      [],
      [
        { repositoryId: 'r1', path: 'root.yml' },
        { repositoryId: 'r1', path: 'docs/old.md' },
        { repositoryId: 'r1', path: 'root.yml' },
      ],
    );
    expect(result.attention.find((row) => row.key === 'outdated-repo-r1')).toMatchObject({
      label: 'Infrastructure',
      detail: '2 outdated drafts outside stacks',
      target: { type: 'repository', id: 'r1' },
    });
  });

  it('does not misattribute a stale stack id from a different repository', () => {
    const result = dashboardWork(
      repos,
      stacks,
      [1, 0, 0],
      [{ repositoryId: 'r2', path: 'compose.yml', stackId: 's1' }],
    );
    expect(result.attention.some((row) => row.key === 'outdated-stack-s1')).toBe(false);
    expect(result.attention.some((row) => row.key === 'outdated-repo-r2')).toBe(true);
  });

  it('treats ordinary drafts as in-progress work rather than an error', () => {
    const result = dashboardWork([repos[0]!], stacks.slice(0, 2), [1, 4], []);
    expect(result.attention).toEqual([]);
    expect(result.draftsInProgress).toHaveLength(2);
  });
});

describe('dashboardRecentActivity', () => {
  it('hides routine noise, keeps failures, and caps results to five', () => {
    const events = [
      { action: 'repository.sync_requested', outcome: 'success' },
      { action: 'repository.test', outcome: 'failure' },
      ...Array.from({ length: 9 }, (_, i) => ({ action: 'git.push', outcome: 'success', id: i })),
    ];
    const selected = dashboardRecentActivity(events);
    expect(selected).toHaveLength(5);
    expect(selected[0]).toMatchObject({ action: 'repository.test', outcome: 'failure' });
    expect(selected[1]).toMatchObject({ action: 'git.push', id: 0 });
    expect(dashboardRecentActivity([], 5)).toEqual([]);
  });
});

describe('dashboardNextStep', () => {
  const syncError = {
    key: 'sync-r2',
    kind: 'sync-error' as const,
    label: 'Backup',
    detail: 'Could not fetch remote.',
    target: { type: 'repository' as const, id: 'r2' },
  };
  const outdated = {
    key: 'outdated-stack-s1',
    kind: 'outdated' as const,
    label: 'traefik',
    detail: '1 outdated draft',
    target: { type: 'stack' as const, id: 's1' },
  };

  it('puts sync failures first and links to the failing repository', () => {
    const step = dashboardNextStep({
      attention: [outdated, syncError],
      openDrafts: 3,
      draftsInProgress: [],
      stackCount: 2,
    });
    expect(step).toMatchObject({
      tone: 'error',
      title: 'Backup could not be fetched',
      action: { target: { type: 'repository', id: 'r2' } },
    });
  });

  it('counts several failures', () => {
    const step = dashboardNextStep({
      attention: [syncError, { ...syncError, key: 'sync-r3', label: 'Other' }],
      openDrafts: 0,
      draftsInProgress: [],
      stackCount: 1,
    });
    expect(step.title).toBe('2 repositories could not be fetched');
  });

  it('asks for a comparison when drafts changed upstream', () => {
    const step = dashboardNextStep({
      attention: [outdated],
      openDrafts: 1,
      draftsInProgress: [],
      stackCount: 2,
    });
    expect(step).toMatchObject({
      tone: 'warn',
      title: 'Drafts in traefik changed upstream',
      action: { label: 'Open stack', target: { type: 'stack', id: 's1' } },
    });
  });

  it('never reports everything committed when draft counts failed', () => {
    const step = dashboardNextStep({ attention: [], openDrafts: null, draftsInProgress: [], stackCount: 2 });
    expect(step.title).toBe('Draft counts are unavailable');
  });

  it('links straight to the only stack with drafts', () => {
    const step = dashboardNextStep({
      attention: [],
      openDrafts: 2,
      draftsInProgress: [{ id: 's2', label: 'wallos', draftCount: 2 }],
      stackCount: 4,
    });
    expect(step).toMatchObject({
      tone: 'progress',
      title: '2 drafts ready to review',
      action: { label: 'Open wallos', target: { type: 'stack', id: 's2' } },
    });
  });

  it('lists stacks with drafts when several have them', () => {
    const step = dashboardNextStep({
      attention: [],
      openDrafts: 3,
      draftsInProgress: [
        { id: 's1', label: 'a', draftCount: 1 },
        { id: 's2', label: 'b', draftCount: 2 },
      ],
      stackCount: 4,
    });
    expect(step.action?.target).toEqual({ type: 'stacks-with-drafts' });
  });

  it('explains stacks when none were found, and invites editing when all is committed', () => {
    expect(
      dashboardNextStep({ attention: [], openDrafts: 0, draftsInProgress: [], stackCount: 0 }).title,
    ).toBe('No stacks found yet');
    expect(
      dashboardNextStep({ attention: [], openDrafts: 0, draftsInProgress: [], stackCount: 3 }),
    ).toMatchObject({ tone: 'calm', title: 'Everything is committed' });
  });
});
