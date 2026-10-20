import { afterEach, describe, expect, it, vi } from 'vitest';
import { boot } from '@/server/boot';
import { createHarness, type TestHarness } from '../support/container';

let h: TestHarness;
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await h?.cleanup();
});

describe('background fetching at boot', () => {
  it.each<Record<string, string>>([
    { STACK_MANAGER_WORKER_ENABLED: 'false' },
    { STACK_MANAGER_AUTO_FETCH_ENABLED: 'false' },
  ])('honours disabled background services: %j', async (env) => {
    h = await createHarness({ env });
    vi.useFakeTimers();
    const worker = vi.spyOn(h.container.worker, 'start').mockImplementation(() => {});
    const scheduler = vi.spyOn(h.container.autoFetch, 'start');
    const term = process.listeners('SIGTERM');
    const interrupt = process.listeners('SIGINT');
    try {
      await boot();
      expect(scheduler).not.toHaveBeenCalled();
      expect(worker).toHaveBeenCalledTimes(h.config.workerEnabled ? 1 : 0);
    } finally {
      for (const listener of process.listeners('SIGTERM')) {
        if (!term.includes(listener)) process.removeListener('SIGTERM', listener);
      }
      for (const listener of process.listeners('SIGINT')) {
        if (!interrupt.includes(listener)) process.removeListener('SIGINT', listener);
      }
      vi.clearAllTimers();
    }
  });
});
