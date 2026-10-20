import { describe, expect, it } from 'vitest';
import { resolveRepositoryFetchPolicy } from '@/server/domain/repository-fetch-policy';

const server = { workerEnabled: true, autoFetchEnabled: true, autoFetchIntervalMinutes: 15 };
const repository = { autoFetchEnabled: true, autoFetchIntervalMinutes: null };

describe('repository fetch policy', () => {
  it('inherits the current server interval until explicitly overridden', () => {
    expect(resolveRepositoryFetchPolicy(repository, server)).toMatchObject({
      enabled: true,
      intervalMinutes: 15,
      disabledReason: null,
    });
    expect(
      resolveRepositoryFetchPolicy(repository, { ...server, autoFetchIntervalMinutes: 30 }).intervalMinutes,
    ).toBe(30);
    expect(
      resolveRepositoryFetchPolicy({ ...repository, autoFetchIntervalMinutes: 5 }, server).intervalMinutes,
    ).toBe(5);
  });

  it.each([
    [{ workerEnabled: false, autoFetchEnabled: false }, false, 'worker'],
    [{ workerEnabled: true, autoFetchEnabled: false }, false, 'server'],
    [{ workerEnabled: true, autoFetchEnabled: true }, false, 'repository'],
    [{ workerEnabled: true, autoFetchEnabled: true }, true, null],
  ] as const)(
    'applies operator switches before repository policy (%j, %s)',
    (switches, enabled, disabledReason) => {
      expect(
        resolveRepositoryFetchPolicy(
          { ...repository, autoFetchEnabled: enabled },
          { ...server, ...switches },
        ),
      ).toMatchObject({ enabled: disabledReason === null, disabledReason });
    },
  );

  it.each([0, -1, 4, 1441, 5.5, NaN, Infinity])('rejects invalid intervals: %s', (interval) => {
    expect(() =>
      resolveRepositoryFetchPolicy({ ...repository, autoFetchIntervalMinutes: interval }, server),
    ).toThrow(/5–1440/);
    expect(() =>
      resolveRepositoryFetchPolicy(repository, { ...server, autoFetchIntervalMinutes: interval }),
    ).toThrow(/5–1440/);
  });
});
