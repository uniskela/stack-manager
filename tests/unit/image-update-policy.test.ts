import { describe, expect, it } from 'vitest';
import {
  parseImageUpdatePolicy,
  policyExcludes,
  resolvePolicyChangelog,
} from '@/server/application/image-update-policy';
import { ValidationError } from '@/server/domain/errors';

const candidate = {
  path: 'apps/wiki/compose.yml',
  service: 'Wiki',
  image: 'example/wiki',
  repository: 'index.docker.io/example/wiki',
  currentTag: '1.0',
  targetTag: '2.0',
};

function parse(config: Record<string, unknown>) {
  return parseImageUpdatePolicy(JSON.stringify({ version: 1, ...config }));
}

describe('repository image update policy', () => {
  it('enables both sources and asks for review by default', () => {
    expect(parseImageUpdatePolicy(null)).toEqual({
      sources: { manual: true, wud: true },
      missingEvidence: 'review',
      riskSignals: 'review',
      respectWudOptOut: true,
      exclude: [],
      changelogs: {},
      serviceChangelogs: [],
    });
  });

  it('merges source defaults and honors explicit policy settings', () => {
    expect(
      parse({
        sources: { manual: false },
        missingEvidence: 'block',
        riskSignals: 'block',
        respectWudOptOut: false,
      }),
    ).toMatchObject({
      sources: { manual: false, wud: true },
      missingEvidence: 'block',
      riskSignals: 'block',
      respectWudOptOut: false,
    });
  });

  it('allows audit-only automation without a Git author', () => {
    expect(parse({ automation: { mode: 'report' } }).automation).toEqual({ mode: 'report' });
    expect(parseImageUpdatePolicy(null).automation).toBeUndefined();
  });

  it('normalizes the Git author before enabling publication', () => {
    const automation = { mode: 'publish', author: { name: ' Update Bot ', email: ' bot@example.org ' } };
    expect(parse({ automation }).automation).toEqual({
      mode: 'publish',
      author: { name: 'Update Bot', email: 'bot@example.org' },
    });
  });

  it.each([
    { mode: 'publish' },
    { mode: 'publish', author: { name: 'Bot', email: 'invalid' } },
    { mode: 'report', author: { name: 'Bot <other>', email: 'bot@example.org' } },
    { mode: 'preview' },
    { mode: 'report', enabled: true },
  ])('rejects invalid automation settings %j', (automation) => {
    expect(() => parse({ automation })).toThrow(ValidationError);
  });

  it('rejects a duplicate mode that can turn reporting into publication', () => {
    expect(() =>
      parseImageUpdatePolicy(
        '{"version":1,"automation":{"mode":"report","mode":"publish","author":{"name":"Bot","email":"bot@example.org"}}}',
      ),
    ).toThrow(ValidationError);
  });

  it.each([
    '{',
    '{}',
    '{"version":2}',
    '{"version":1,"unknown":true}',
    '{"version":1,"__proto__":{}}',
    '{"version":1,"sources":{"other":true}}',
    '{"version":1,"sources":{"wud":"false"}}',
    '{"version":1,"missingEvidence":"ignore"}',
    '{"version":1,"exclude":[{"path":"compose.yml","pattern":true}]}',
    '{"version":1,"changelogs":{"example/wiki:2":"https://example.org/releases"}}',
    '{"version":1,"changelogs":{"__proto__":"https://example.org/releases"}}',
  ])('rejects malformed policy %s', (json) => {
    expect(() => parseImageUpdatePolicy(json)).toThrow(ValidationError);
  });

  it.each([
    '',
    'apps/../compose.yml',
    'apps\\compose.yml',
    '/compose.yml',
    './compose.yml',
    'apps//compose.yml',
  ])('rejects a non-normalized exclusion path %j', (path) => {
    expect(() => parse({ exclude: [{ path }] })).toThrow(ValidationError);
  });

  it('bounds policy text and rule counts', () => {
    expect(() => parseImageUpdatePolicy(' '.repeat(65_537) + '{"version":1}')).toThrow(ValidationError);
    expect(() => parse({ exclude: Array.from({ length: 101 }, () => ({ path: 'compose.yml' })) })).toThrow(
      ValidationError,
    );
  });

  it('matches only the exact path and service and supports file-wide exclusions', () => {
    const policy = parse({
      exclude: [{ path: candidate.path, service: 'Wiki' }, { path: 'compose.yml' }],
    });
    expect(policyExcludes(policy, candidate.path, 'Wiki')).toBe(true);
    expect(policyExcludes(policy, candidate.path, 'wiki')).toBe(false);
    expect(policyExcludes(policy, 'apps/another/compose.yml', 'Wiki')).toBe(false);
    expect(policyExcludes(policy, 'compose.yml', 'Wiki')).toBe(true);
    expect(() => parse({ exclude: [{ path: candidate.path, service: 'Wiki.*' }] })).toThrow(ValidationError);
  });

  it('prefers an override, exact service, original image name, then canonical image name', () => {
    const policy = parse({
      changelogs: {
        'example/wiki': 'https://example.org/image',
        'index.docker.io/example/wiki': 'https://example.org/canonical',
      },
      serviceChangelogs: [{ path: candidate.path, service: 'Wiki', url: 'https://example.org/service' }],
    });
    expect(resolvePolicyChangelog(policy, { ...candidate, override: 'https://example.org/override' })).toBe(
      'https://example.org/override',
    );
    expect(resolvePolicyChangelog(policy, candidate)).toBe('https://example.org/service');
    expect(resolvePolicyChangelog(policy, { ...candidate, service: 'wiki' })).toBe(
      'https://example.org/image',
    );
    expect(
      resolvePolicyChangelog(policy, { ...candidate, service: 'wiki', image: 'docker.io/example/wiki' }),
    ).toBe('https://example.org/canonical');
    expect(resolvePolicyChangelog(parseImageUpdatePolicy(null), candidate)).toBeNull();
  });

  it('encodes tag values within the URL path', () => {
    const policy = parse({ changelogs: { 'example/wiki': 'https://example.org/{{current}}...{{target}}' } });
    expect(resolvePolicyChangelog(policy, { ...candidate, targetTag: 'v2/?#' })).toBe(
      'https://example.org/1.0...v2%2F%3F%23',
    );
  });

  it('preserves simple release anchors in configured and entered URLs', () => {
    const policy = parse({
      changelogs: { 'example/wiki': 'https://example.org/releases/{{target}}#highlights' },
    });
    expect(resolvePolicyChangelog(policy, candidate)).toBe('https://example.org/releases/2.0#highlights');
    expect(
      resolvePolicyChangelog(policy, { ...candidate, override: 'https://example.org/releases#v2.0-beta' }),
    ).toBe('https://example.org/releases#v2.0-beta');
  });

  it.each([
    'http://example.org/releases',
    'https://{{current}}.example.org/releases',
    'https://user:password@example.org/releases',
    'https://@example.org/releases',
    'https://example.org/releases?tag={{target}}',
    'https://example.org/releases?',
    'https://example.org/releases#',
    'https://example.org/releases#{{target}}',
    'https://example.org/releases#v2%2Fbeta',
    'https://example.org/releases/{{next}}',
    'https://example.org\\releases',
  ])('rejects changelog templates outside the HTTPS path format', (url) => {
    const parseUrl = () => parse({ changelogs: { 'example/wiki': url } });
    expect(parseUrl).toThrow(ValidationError);
    expect(parseUrl).not.toThrow(url);
  });

  it('uses the configured changelog when a runtime override is invalid', () => {
    const policy = parse({ changelogs: { 'example/wiki': 'https://example.org/releases' } });
    expect(resolvePolicyChangelog(policy, { ...candidate, override: 'http://example.org/unsafe' })).toBe(
      'https://example.org/releases',
    );
  });
});
