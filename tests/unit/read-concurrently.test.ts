import { expect, it } from 'vitest';
import { readConcurrently } from '@/server/application/read-concurrently';

it('limits active reads and returns results in input order when a later read finishes first', async () => {
  const first = Promise.withResolvers<void>();
  const thirdStarted = Promise.withResolvers<void>();
  const started: number[] = [];
  const results = readConcurrently([0, 1, 2], 2, async (item) => {
    started.push(item);
    if (item === 0) await first.promise;
    if (item === 2) thirdStarted.resolve();
    return item;
  });
  expect(started).toEqual([0, 1]);
  await thirdStarted.promise;
  first.resolve();
  expect(await results).toEqual([0, 1, 2]);
});
