import { describe, expect, it } from 'vitest';
import { parseWudUpdateGroups, wudGroupPaths, wudGroupPlan } from '@/server/application/wud-update-groups';

const composePath = 'apps/n8n/compose.yml';
const dockerfilePath = 'apps/n8n/Dockerfile.runners';
const n8n = { path: composePath, service: 'n8n', before: 'n8n:1.0', after: 'n8n:2.0' };
const runner = {
  path: composePath,
  service: 'sandbox-runner',
  before: 'example/sandbox-runner:1.0',
  after: 'example/sandbox-runner:2.0',
};

function policy(groups: unknown[]) {
  return parseWudUpdateGroups(JSON.stringify({ version: 1, groups }));
}

const n8nRule = {
  id: 'n8n',
  members: [{ path: composePath, service: 'n8n' }],
  dependents: [
    {
      path: composePath,
      service: 'task-runners',
      old: 'example/runners:{current}-custom',
      new: 'example/runners:{target}-custom',
      image_ref: true,
    },
    {
      path: dockerfilePath,
      old: 'ARG RUNNERS_VERSION={current}',
      new: 'ARG RUNNERS_VERSION={target}',
    },
  ],
};

const sandboxRule = {
  id: 'sandbox',
  require_all_members: true,
  members: [
    { path: composePath, service: 'n8n' },
    { path: composePath, service: 'sandbox-runner' },
  ],
  dependents: [
    {
      path: composePath,
      service: 'sandbox-runner',
      old: 'example/sandbox:{current}',
      new: 'example/sandbox:{target}',
      image_ref: true,
    },
    {
      path: composePath,
      service: 'sandbox-runner',
      old: 'example/sandbox-runner:{current}',
      new: 'example/sandbox-runner:{target}',
      image_ref: true,
    },
  ],
};

describe('parseWudUpdateGroups', () => {
  it('refuses duplicate JSON keys', () => {
    expect(() => parseWudUpdateGroups('{"version": 2, "version": 1, "groups": []}')).toThrow();
  });

  it.each([
    '../compose.yml',
    './compose.yml',
    'apps//compose.yml',
    '/compose.yml',
    'C:/compose.yml',
    '.git/config',
    'secrets/config',
    '.env',
  ])('refuses unsafe policy paths (%s)', (path) =>
    expect(() => policy([{ ...n8nRule, members: [{ path, service: 'app' }] }])).toThrow(),
  );

  it.each([
    [n8nRule, { ...n8nRule, id: 'conflicting-membership' }],
    [{ ...n8nRule, command: 'echo bad' }],
    [{ ...n8nRule, dependents: [{ path: dockerfilePath, old: '{invalid}', new: '{target}' }] }],
    [
      {
        ...n8nRule,
        dependents: [{ ...n8nRule.dependents[1], new: 'ARG RUNNERS_VERSION={target}\nRUN false' }],
      },
    ],
  ])('refuses ambiguous or unsupported group policy', (...groups) => {
    expect(() => policy(groups)).toThrow();
  });
});

describe('wudGroupPlan', () => {
  it('preserves unrelated text while updating the Compose fallback and exact Dockerfile line', () => {
    const groups = policy([n8nRule]);
    expect(wudGroupPaths(groups, [n8n])).toEqual([composePath, dockerfilePath]);
    const compose = [
      'services:',
      '  n8n:',
      '    image: n8n:1.0',
      '  task-runners:',
      '    image: "${N8N_RUNNERS_IMAGE:-example/runners:1.0-custom}" # example/runners:1.0-custom',
      '  other:',
      '    image: example/runners:1.0-custom',
      '',
    ].join('\r\n');
    const dockerfile = 'ARG RUNNERS_VERSION=1.0\r\n# ARG RUNNERS_VERSION=1.0\n';
    const result = wudGroupPlan(
      groups,
      [n8n],
      new Map([
        [composePath, compose],
        [dockerfilePath, dockerfile],
      ]),
    );
    expect(result.files).toEqual(
      new Map([
        [
          composePath,
          compose.replace('image: n8n:1.0', 'image: n8n:2.0').replace('1.0-custom}"', '2.0-custom}"'),
        ],
        [dockerfilePath, 'ARG RUNNERS_VERSION=2.0\r\n# ARG RUNNERS_VERSION=1.0\n'],
      ]),
    );
    expect(result.groups).toEqual([{ id: 'n8n', members: [{ path: composePath, service: 'n8n' }] }]);
    expect(result.imageChanges).toEqual([
      n8n,
      {
        path: composePath,
        service: 'task-runners',
        before: 'example/runners:1.0-custom',
        after: 'example/runners:2.0-custom',
      },
    ]);
  });

  it('updates a service environment image and deduplicates a dependency identical to a member edit', () => {
    const compose =
      'services:\n  n8n:\n    image: n8n:1.0\n  sandbox-runner:\n' +
      '    image: example/sandbox-runner:1.0\n    environment:\n' +
      '      SANDBOX_IMAGE: example/sandbox:1.0\n';
    const result = wudGroupPlan(policy([sandboxRule]), [n8n, runner], new Map([[composePath, compose]]));
    expect(result.files.get(composePath)).toBe(
      'services:\n  n8n:\n    image: n8n:2.0\n  sandbox-runner:\n' +
        '    image: example/sandbox-runner:2.0\n    environment:\n' +
        '      SANDBOX_IMAGE: example/sandbox:2.0\n',
    );
    expect(result.imageChanges).toEqual([
      n8n,
      runner,
      {
        path: composePath,
        service: 'sandbox-runner',
        before: 'example/sandbox:1.0',
        after: 'example/sandbox:2.0',
      },
    ]);
  });

  it('refuses a dependent that would give a selected image a different tag', () => {
    const compose = 'services: {n8n: {image: n8n:1.0}, sandbox-runner: {image: example/sandbox-runner:1.0}}';
    const conflict = {
      ...sandboxRule,
      dependents: [{ ...sandboxRule.dependents[1], new: 'example/sandbox-runner:{target}-custom' }],
    };
    expect(() => wudGroupPlan(policy([conflict]), [n8n, runner], new Map([[composePath, compose]]))).toThrow(
      /overlap/i,
    );
  });

  it.each([
    { selected: [n8n], message: /every member/i },
    { selected: [n8n, { ...runner, before: 'example/sandbox-runner:0.9' }], message: /current.*target/i },
    { selected: [n8n, { ...runner, after: 'example/sandbox-runner:3.0' }], message: /current.*target/i },
  ])('refuses incomplete or incompatible linked selections', ({ selected, message }) => {
    const compose = 'services: {n8n: {image: n8n:1.0}, sandbox-runner: {image: example/sandbox-runner:1.0}}';
    expect(() => wudGroupPlan(policy([sandboxRule]), selected, new Map([[composePath, compose]]))).toThrow(
      message,
    );
  });

  it.each([
    ['missing', { image: 'example/runners:1.0-custom2' }, 'ARG RUNNERS_VERSION=1.0\n'],
    ['comment only', { image: 'example/unrelated:1.0' }, 'ARG RUNNERS_VERSION=1.0\n'],
    [
      'duplicate scoped values',
      { image: 'example/runners:1.0-custom', environment: ['IMAGE=example/runners:1.0-custom'] },
      'ARG RUNNERS_VERSION=1.0\n',
    ],
    [
      'duplicate Dockerfile lines',
      { image: 'example/runners:1.0-custom' },
      'ARG RUNNERS_VERSION=1.0\nARG RUNNERS_VERSION=1.0\n',
    ],
    [
      'partial Dockerfile line',
      { image: 'example/runners:1.0-custom' },
      'ARG RUNNERS_VERSION=1.0 # comment\n',
    ],
  ])('refuses a dependency with %s', (_case, runnerService, dockerfile) => {
    const compose =
      'services: {n8n: {image: n8n:1.0}, task-runners: ' +
      JSON.stringify(runnerService) +
      '} # example/runners:1.0-custom';
    const files = new Map([
      [composePath, compose],
      [dockerfilePath, dockerfile],
    ]);
    expect(() => wudGroupPlan(policy([n8nRule]), [n8n], files)).toThrow(/exactly one/i);
    expect([...files]).toEqual([
      [composePath, compose],
      [dockerfilePath, dockerfile],
    ]);
  });
});
