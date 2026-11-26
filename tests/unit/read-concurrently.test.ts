import { setImmediate } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { readConcurrently } from '@/server/application/read-concurrently';

it('limits active reads and returns results in input order when a later read finishes first', async () => {
  const started: number[] = [];
  const finished: number[] = [];
  const results = readConcurrently([0, 1, 2], 2, async (item) => {
    started.push(item);
    if (item === 0) await setImmediate();
    finished.push(item);
    return item;
  });
  expect(started).toEqual([0, 1]);
  expect(await results).toEqual([0, 1, 2]);
  expect(finished).toEqual([1, 2, 0]);
});
