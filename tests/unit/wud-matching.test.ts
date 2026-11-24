import { describe, expect, it } from 'vitest';
import {
  canonicalImageRepository,
  discoverWudMappings,
  inspectStackImages,
  matchImageUpdates,
  type WudObservation,
} from '@/shared/image-updates';

const now = new Date('2026-11-23T07:15:00Z');
const binding = { watcher: 'local', project: 'wiki' };
const service = { name: 'web', image: 'nginx:1.26', excluded: false, editable: true };
const observation: WudObservation = {
  ...binding,
  service: 'web',
  repository: 'index.docker.io/library/nginx',
  installedTag: '1.26',
  installedDigest: null,
  checkedAt: '2026-11-23T07:00:00Z',
  available: true,
  failed: false,
  candidateTag: '1.27',
  digestOnly: false,
};

describe('WUD mapping discovery', () => {
  const stack = { stackId: 'source-stack', stackName: 'Documentation', images: [service] };

  it('suggests a unique watcher and project based on committed service and image identity', () => {
    const matches = discoverWudMappings(
      [stack],
      [],
      [observation, { ...observation, watcher: 'other', installedTag: '1.25' }],
      now,
    );
    expect(matches).toEqual({
      suggestions: [
        {
          stackId: 'source-stack',
          stackName: 'Documentation',
          watcher: 'local',
          project: 'wiki',
          matchedServices: ['web'],
        },
      ],
      ambiguousCount: 0,
      unmatchedCount: 0,
    });
  });

  it('withholds a project that matches multiple stacks and a stack that matches multiple projects', () => {
    expect(discoverWudMappings([stack, { ...stack, stackId: 'copy' }], [], [observation], now)).toMatchObject(
      { suggestions: [], ambiguousCount: 2 },
    );
    expect(
      discoverWudMappings([stack], [], [observation, { ...observation, watcher: 'other' }], now),
    ).toMatchObject({ suggestions: [], ambiguousCount: 1 });
  });

  it.each([
    ['an already linked project', [binding], [observation], service],
    ['an opted-out service', [], [observation], { ...service, excluded: true }],
    ['a stale observation', [], [{ ...observation, checkedAt: '2026-11-21T07:00:00Z' }], service],
    [
      'replicas with different installed images',
      [],
      [observation, { ...observation, installedTag: '2' }],
      service,
    ],
  ] as const)('withholds %s', (_description, claimed, observations, image) => {
    expect(discoverWudMappings([{ ...stack, images: [image] }], claimed, observations, now)).toEqual({
      suggestions: [],
      ambiguousCount: 0,
      unmatchedCount: 1,
    });
  });
});

describe('WUD image update matching', () => {
  it('accepts OCI path separators within and between components', () => {
    const path = 'team.one/team_two/app__image---build';
    expect(canonicalImageRepository('Registry.Example:12345', path)).toBe(`registry.example:12345/${path}`);
    expect(canonicalImageRepository('hub.docker.com', 'nginx')).toBe('index.docker.io/library/nginx');
    expect(canonicalImageRepository('hub.docker.com', path)).toBe(`index.docker.io/${path}`);
    const maxLengthPath = 'a'.repeat(255);
    expect(canonicalImageRepository('docker.io', maxLengthPath)).toBe(
      `index.docker.io/library/${maxLengthPath}`,
    );
  });

  it.each(['', '/nginx', 'team//nginx', 'team/', 'team/Nginx', 'app___image', 'app.-image', 'a'.repeat(256)])(
    'rejects an invalid OCI path %j',
    (path) => {
      expect(canonicalImageRepository('docker.io', path)).toBeNull();
    },
  );

  it('matches a canonical Docker Hub image on the bound watcher, project and service', () => {
    const result = matchImageUpdates(
      [service],
      binding,
      [
        { ...observation, project: 'unrelated', candidateTag: '2.0' },
        { ...observation, watcher: 'other', candidateTag: '2.0' },
        observation,
      ],
      now,
      false,
    );
    expect(result[0]).toMatchObject({ status: 'available', candidateTag: '1.27' });
  });

  it('shows the candidate when the WUD API omits its last scan time', () => {
    const result = matchImageUpdates([service], binding, [{ ...observation, checkedAt: null }], now, false);
    expect(result[0]).toMatchObject({ status: 'available', candidateTag: '1.27', scanTimeUnavailable: true });
  });

  it('respects a WUD opt-out in an aliased service label map', () => {
    const images = inspectStackImages(
      'x-policy: &policy\n  wud.watch: "false"\nservices:\n  web:\n    image: nginx:1.26\n    labels: *policy\n',
    );
    expect(images?.[0]).toMatchObject({ name: 'web', excluded: true });
  });

  it.each([
    ['drift', { installedTag: '1.25' }, false],
    ['stale', { checkedAt: '2026-11-21T07:00:00Z' }, false],
    ['stale', {}, true],
    ['error', { failed: true }, false],
    ['digest', { digestOnly: true, candidateTag: '1.26' }, false],
    ['current', { available: false }, false],
  ] as const)('reports %s', (status, changes, staleSnapshot) => {
    expect(
      matchImageUpdates([service], binding, [{ ...observation, ...changes }], now, staleSnapshot)[0]?.status,
    ).toBe(status);
  });

  it('does not choose between conflicting reports from replicas', () => {
    expect(
      matchImageUpdates(
        [service],
        binding,
        [observation, { ...observation, candidateTag: '1.28' }],
        now,
        false,
      )[0]?.status,
    ).toBe('ambiguous');
  });

  it('detects source opt-outs and lists build, alias, and interpolated images without a candidate', () => {
    const inventory = inspectStackImages(`services:
  web:
    image: &shared nginx:1.26
    labels:
      wud.watch: false
  linked:
    image: *shared
  worker:
    image: worker:\${TAG}
  local:
    build: .
  cache:
    image: redis:7
    labels: [wud.watch=false]
`);
    expect(inventory?.map((item) => [item.name, item.excluded, item.editable])).toEqual([
      ['web', true, false],
      ['linked', false, false],
      ['worker', false, false],
      ['local', false, false],
      ['cache', true, true],
    ]);
  });
});
