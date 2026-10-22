import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROUTING_POLICY,
  MAX_CHANGED_PATHS,
  MAX_ROUTING_PATTERNS,
  evaluateRouting,
  normalizeChangedPaths,
  validateRoutingPolicy,
} from '@/shared/deployment-routing';

const stack = {
  stackId: 'wiki',
  rootPath: 'apps/wiki',
  composePath: 'compose.yaml',
  enabled: true,
  deployOnPush: true,
  credentialAvailable: true,
  policy: { ...DEFAULT_ROUTING_POLICY, dependencies: ['shared/proxy/**'] },
};

describe('deployment routing', () => {
  it.each([
    ['compose change', ['apps/wiki/compose.yaml'], ['apps/wiki/compose.yaml']],
    ['README only', ['apps/wiki/README.md'], []],
    ['configuration', ['apps/wiki/config/nginx/site.conf'], ['apps/wiki/config/nginx/site.conf']],
    ['runtime script', ['apps/wiki/scripts/runtime/start.sh'], ['apps/wiki/scripts/runtime/start.sh']],
    ['dependency', ['shared/proxy/nginx.conf'], ['shared/proxy/nginx.conf']],
    ['unrelated sibling', ['apps/wiki-other/compose.yaml'], []],
    ['unrelated repository file', ['package.json'], []],
    ['deleted compose', ['apps/wiki/docker-compose.yml'], ['apps/wiki/docker-compose.yml']],
    ['rename out of root', ['apps/wiki/compose.yaml', 'archived/compose.yaml'], ['apps/wiki/compose.yaml']],
    ['rename into root', ['other/compose.yaml', 'apps/wiki/compose.yaml'], ['apps/wiki/compose.yaml']],
    ['no changes', [], []],
  ])('%s', (_name, paths, matchedPaths) => {
    const result = evaluateRouting(paths, stack);
    expect(result.stackId).toBe('wiki');
    expect(result.matchedPaths).toEqual(matchedPaths);
    expect(result.relevant).toBe(matchedPaths.length > 0);
    expect(result.deployEligible).toBe(matchedPaths.length > 0);
    expect(result.explanation.length).toBeGreaterThan(0);
  });

  it('applies exclusions in root-relative and dependency repo-relative scopes', () => {
    const policy = {
      include: ['**'],
      exclude: ['config/ignored/**', 'shared/proxy/docs/**'],
      dependencies: ['shared/proxy/**'],
    };
    expect(
      evaluateRouting(
        ['apps/wiki/config/ignored/a.conf', 'shared/proxy/docs/setup.txt', 'shared/proxy/nginx.conf'],
        { ...stack, policy },
      ).matchedPaths,
    ).toEqual(['shared/proxy/nginx.conf']);
  });

  it('requires an explicit include for root paths, including the primary compose file', () => {
    const policy = { include: [], exclude: [], dependencies: ['shared/proxy/**'] };
    expect(evaluateRouting(['apps/wiki/compose.yaml'], { ...stack, policy }).relevant).toBe(false);
    expect(evaluateRouting(['shared/proxy/a.conf'], { ...stack, policy }).relevant).toBe(true);
    expect(evaluateRouting(['apps/wiki/custom.yml'], { ...stack, composePath: 'custom.yml' }).relevant).toBe(
      false,
    );
    expect(
      evaluateRouting(['apps/wiki/compose.yaml'], {
        ...stack,
        policy: { include: ['compose.yaml'], exclude: ['compose.yaml'], dependencies: [] },
      }).relevant,
    ).toBe(false);
  });

  it('keeps dependency matches within the root independent of includes but respects either exclusion scope', () => {
    const policy = { include: [], exclude: [], dependencies: ['apps/wiki/shared/**'] };
    expect(evaluateRouting(['apps/wiki/shared/a.conf'], { ...stack, policy }).relevant).toBe(true);
    for (const exclude of ['shared/**', 'apps/wiki/shared/**']) {
      expect(
        evaluateRouting(['apps/wiki/shared/a.conf'], { ...stack, policy: { ...policy, exclude: [exclude] } })
          .relevant,
      ).toBe(false);
    }
  });

  it.each([
    [{ enabled: false }, 'deployment_disabled'],
    [{ deployOnPush: false }, 'deploy_on_push_disabled'],
    [{ credentialAvailable: false }, 'credential_missing'],
  ])('reports relevant changes separately from deployment eligibility: %j', (flags, reasonCode) => {
    expect(evaluateRouting(['apps/wiki/compose.yaml'], { ...stack, ...flags })).toMatchObject({
      relevant: true,
      deployEligible: false,
      reasonCode,
    });
  });

  it('uses defaults for a missing policy', () => {
    expect(evaluateRouting(['apps/wiki/compose.yaml'], { ...stack, policy: null }).deployEligible).toBe(true);
  });

  it('routes overlapping roots and shared dependencies independently for multiple stacks', () => {
    const paths = ['apps/wiki/nested/compose.yaml', 'shared/proxy/nginx.conf'];
    const stacks = [
      { ...stack, policy: { include: ['**/compose.yaml'], exclude: [], dependencies: [] } },
      { ...stack, stackId: 'nested', rootPath: 'apps/wiki/nested' },
      { ...stack, stackId: 'notes', rootPath: 'apps/notes' },
      { ...stack, stackId: 'photos', rootPath: 'media/photos', policy: DEFAULT_ROUTING_POLICY },
    ];
    expect(stacks.map((item) => evaluateRouting(paths, item).relevant)).toEqual([true, true, true, false]);
    expect(evaluateRouting(['compose.yaml'], { ...stack, rootPath: '' }).relevant).toBe(true);
  });

  it.each([
    ['config/*.y?l', 'config/app.yml', true],
    ['config/*.y?l', 'config/nested/app.yml', false],
    ['config/**/app.*', 'config/app.yml', true],
    ['config/**/app.*', 'config/a/b/app.yml', true],
    ['config/?.yml', 'config/ab.yml', false],
    ['**/*.md', 'README.md', true],
    ['**/*.md', 'docs/README.md', true],
    ['*.md', 'docs/README.md', false],
    ['config/**', 'configuration/app.yml', false],
    ['config/😀.yml', 'config/😀.yml', true],
    ['config/?.yml', 'config/😀.yml', true],
  ])('matches bounded glob %s against %s', (pattern, path, relevant) => {
    expect(
      evaluateRouting([`apps/wiki/${path}`], {
        ...stack,
        policy: { include: [pattern], exclude: [], dependencies: [] },
      }).relevant,
    ).toBe(relevant);
  });

  it('deduplicates and sorts paths and produces stable decisions without mutating inputs', () => {
    const paths = ['shared/proxy/z.conf', './apps/wiki//compose.yaml', 'shared/proxy/z.conf'];
    const result = evaluateRouting(paths, stack);
    expect(result.matchedPaths).toEqual(['apps/wiki/compose.yaml', 'shared/proxy/z.conf']);
    expect(evaluateRouting([...paths].reverse(), stack)).toEqual(result);
    expect(paths[1]).toBe('./apps/wiki//compose.yaml');
    expect(normalizeChangedPaths(paths)).toEqual(['apps/wiki/compose.yaml', 'shared/proxy/z.conf']);
  });

  it('keeps ordinal order for case and canonically distinct Unicode paths', () => {
    const paths = ['é', 'a', 'e\u0301', 'A', 'é'];
    const expected = ['A', 'a', 'e\u0301', 'é'];
    expect(normalizeChangedPaths(paths)).toEqual(expected);
    expect(normalizeChangedPaths([...paths].reverse())).toEqual(expected);
  });

  it('handles repeated wildcard near misses without recursive backtracking', () => {
    expect(
      evaluateRouting([`apps/wiki/${'a'.repeat(1000)}`], {
        ...stack,
        policy: { include: [`${'a*'.repeat(100)}z`], exclude: [], dependencies: [] },
      }).relevant,
    ).toBe(false);
  });
});

describe('routing policy validation', () => {
  it('accepts empty lists and returns an independent policy', () => {
    const input = { include: [], exclude: ['docs/**'], dependencies: [] };
    const policy = validateRoutingPolicy(input);
    expect(policy).toEqual(input);
    expect(policy.exclude).not.toBe(input.exclude);
  });

  it.each([
    null,
    [],
    {},
    { include: 'compose.yaml', exclude: [], dependencies: [] },
    { include: [2], exclude: [], dependencies: [] },
  ])('rejects malformed policy %j', (value) => {
    expect(() => validateRoutingPolicy(value)).toThrow(/policy|include|exclude|dependencies/i);
  });

  it.each([
    '',
    '/compose.yaml',
    '../compose.yaml',
    'config/../x',
    './config/**',
    'a//b',
    'a/',
    'C:/compose.yaml',
    'config\\**',
    'config/{a,b}',
    '[ab].yml',
    '!README.md',
    '@(a)',
    'config/***',
    'config/a**b',
    'a\nb',
    '.git/**',
    'x'.repeat(257),
  ])('rejects unsupported or unsafe glob %j', (pattern) => {
    expect(() => validateRoutingPolicy({ include: [pattern], exclude: [], dependencies: [] })).toThrow();
  });

  it('bounds policy size and changed paths', () => {
    expect(() =>
      validateRoutingPolicy({
        include: Array(MAX_ROUTING_PATTERNS + 1).fill('a'),
        exclude: [],
        dependencies: [],
      }),
    ).toThrow(/many|limit/i);
    expect(() => normalizeChangedPaths(Array(MAX_CHANGED_PATHS + 1).fill('a'))).toThrow(/many|limit/i);
    expect(() => normalizeChangedPaths(['x'.repeat(1025)])).toThrow();
  });

  it.each(['/etc/passwd', '../outside', 'a\u0000b', 'a/.git/config', 'C:/file', 'a\\b'])(
    'rejects unsafe changed path %j',
    (path) => {
      expect(() => normalizeChangedPaths([path])).toThrow();
    },
  );
});

it('rejects excessive wildcard matching work before evaluating it', () => {
  expect(() =>
    evaluateRouting(
      Array.from({ length: 1000 }, (_, i) => `config/${i}${'a'.repeat(200)}`),
      {
        stackId: 'bounded',
        rootPath: '',
        composePath: 'compose.yaml',
        enabled: true,
        deployOnPush: true,
        policy: { include: Array(32).fill('a'.repeat(250)), exclude: [], dependencies: [] },
      },
    ),
  ).toThrow(/work limit/);
});
