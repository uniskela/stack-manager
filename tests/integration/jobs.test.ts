import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JOB_LEASE_TTL_MS, PermanentJobError, retryDelayMs, type Job } from '@/server/domain/job';
import { JobWorker, type JobHandler } from '@/server/jobs/worker';
import { createHarness, type TestHarness } from '../support/container';

let h: TestHarness;
beforeEach(async () => {
  h = await createHarness({ overrides: { workerOptions: { workerId: 'default' } } });
});
afterEach(async () => h.cleanup());

function worker(id: string, handler: JobHandler, opts: { heartbeatIntervalMs?: number } = {}) {
  return new JobWorker(
    h.container.repos.jobs,
    new Map([['test_job', handler]]),
    h.clock,
    h.container.logger,
    {
      workerId: id,
      heartbeatIntervalMs: opts.heartbeatIntervalMs ?? 60_000,
    },
  );
}

const enqueue = (
  payload: Record<string, unknown> = { n: 1 },
  opts: Parameters<TestHarness['container']['jobs']['enqueue']>[2] = {},
) => h.container.jobs.enqueue('test_job', payload, opts);

const get = async (id: string) => (await h.container.jobs.get(id))!;

describe('persisted jobs', () => {
  it('runs a pending job to success and clears the lease', async () => {
    const { job } = await enqueue();
    const seen: Job[] = [];
    const w = worker('w1', async (j) => void seen.push(j));
    expect(await w.runOnce()).toBe(true);
    expect(seen[0]).toMatchObject({ id: job.id, status: 'running', leaseOwner: 'w1' });
    expect(seen[0]!.leaseExpiresAt!.getTime()).toBe(h.clock.now().getTime() + JOB_LEASE_TTL_MS);
    expect(await get(job.id)).toMatchObject({
      status: 'succeeded',
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
    });
    expect(await w.runOnce()).toBe(false);
  });

  it('honours runAfter', async () => {
    const { job } = await enqueue({}, { delayMs: 10_000 });
    const w = worker('w1', async () => {});
    expect(await w.runOnce()).toBe(false);
    h.clock.advance(10_000);
    expect(await w.runOnce()).toBe(true);
    expect((await get(job.id)).status).toBe('succeeded');
  });

  it('retries with backoff, then moves to dead after maxAttempts', async () => {
    const { job } = await enqueue({}, { maxAttempts: 3 });
    const w = worker('w1', async () => {
      throw new Error('boom https://user:secret-token-value@git.example/x');
    });
    await w.runOnce();
    let j = await get(job.id);
    expect(j).toMatchObject({ status: 'pending', attempts: 1, leaseOwner: null });
    expect(j.runAfter.getTime()).toBe(h.clock.now().getTime() + retryDelayMs(1));
    expect(j.lastError).not.toContain('secret-token-value');
    h.clock.advance(retryDelayMs(1));
    await w.runOnce();
    expect((await get(job.id)).attempts).toBe(2);
    h.clock.advance(retryDelayMs(2));
    await w.runOnce();
    j = await get(job.id);
    expect(j).toMatchObject({ status: 'dead', attempts: 3 });
    expect(j.finishedAt).not.toBeNull();
  });

  it('marks permanent errors failed without retrying', async () => {
    const { job } = await enqueue();
    await worker('w1', async () => {
      throw new PermanentJobError('bad input');
    }).runOnce();
    expect(await get(job.id)).toMatchObject({
      status: 'failed',
      attempts: 1,
      lastError: 'PermanentJobError: bad input',
    });
  });

  it('reclaims a stale lease after a crash and re-runs the job exactly once more', async () => {
    const { job } = await enqueue();
    // Worker A claims, then "crashes": we claim directly without completing.
    const claimed = await h.container.repos.jobs.claimNext(
      'crashed-worker',
      h.clock.now(),
      JOB_LEASE_TTL_MS,
      ['test_job'],
    );
    expect(claimed!.id).toBe(job.id);

    const runs: string[] = [];
    const b = worker('w2', async (j) => void runs.push(j.id));
    // Lease still valid: nothing to do.
    expect(await b.runOnce()).toBe(false);
    expect((await get(job.id)).status).toBe('running');

    // Lease expires → reclaimed to pending with attempts+1 and backoff.
    h.clock.advance(JOB_LEASE_TTL_MS + 1);
    expect(await b.runOnce()).toBe(false);
    const requeued = await get(job.id);
    expect(requeued).toMatchObject({
      status: 'pending',
      attempts: 1,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    expect(requeued.lastError).toMatch(/Lease expired/);

    h.clock.advance(retryDelayMs(1));
    expect(await b.runOnce()).toBe(true);
    expect(runs).toEqual([job.id]);
    expect((await get(job.id)).status).toBe('succeeded');

    // The crashed worker can no longer complete it (fenced on leaseOwner).
    expect(await h.container.repos.jobs.markSucceeded(job.id, 'crashed-worker', h.clock.now())).toBe(false);
  });

  it('a stale lease on the final attempt becomes dead', async () => {
    const { job } = await enqueue({}, { maxAttempts: 1 });
    await h.container.repos.jobs.claimNext('crashed', h.clock.now(), JOB_LEASE_TTL_MS, ['test_job']);
    h.clock.advance(JOB_LEASE_TTL_MS + 1);
    const res = await h.container.repos.jobs.reclaimExpired(h.clock.now(), retryDelayMs);
    expect(res).toEqual({ requeued: 0, dead: 1 });
    expect((await get(job.id)).status).toBe('dead');
  });

  it('heartbeats extend the lease so long jobs are not reclaimed', async () => {
    const { job } = await enqueue();
    const claimed = (await h.container.repos.jobs.claimNext('w1', h.clock.now(), JOB_LEASE_TTL_MS, [
      'test_job',
    ]))!;
    h.clock.advance(50_000);
    expect(await h.container.repos.jobs.heartbeat(job.id, 'w1', h.clock.now(), JOB_LEASE_TTL_MS)).toBe(true);
    h.clock.advance(50_000); // 100s after claim; original lease would have expired at 60s
    expect(await h.container.repos.jobs.reclaimExpired(h.clock.now(), retryDelayMs)).toEqual({
      requeued: 0,
      dead: 0,
    });
    const j = await get(job.id);
    expect(j.heartbeatAt!.getTime()).toBeGreaterThan(claimed.heartbeatAt!.getTime());
    expect(
      await h.container.repos.jobs.heartbeat(job.id, 'someone-else', h.clock.now(), JOB_LEASE_TTL_MS),
    ).toBe(false);
  });

  it('aborts a handler whose lease was lost and does not record its result', async () => {
    const { job } = await enqueue();
    let aborted = false;
    const w = worker(
      'w1',
      async (_j, ctx) => {
        // Simulate another worker reclaiming the job mid-flight.
        h.clock.advance(JOB_LEASE_TTL_MS + 1);
        await h.container.repos.jobs.reclaimExpired(h.clock.now(), () => 0);
        await new Promise<void>((resolve) => {
          ctx.signal.addEventListener('abort', () => {
            aborted = true;
            resolve();
          });
        });
      },
      { heartbeatIntervalMs: 20 },
    );
    await w.runOnce();
    expect(aborted).toBe(true);
    expect((await get(job.id)).status).toBe('pending');
  });

  it('dedupes active jobs by key and allows a new one after completion', async () => {
    const a = await enqueue({}, { dedupeKey: 'repo:1' });
    const b = await enqueue({}, { dedupeKey: 'repo:1' });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.job.id).toBe(a.job.id);
    await worker('w1', async () => {}).runOnce();
    const c = await enqueue({}, { dedupeKey: 'repo:1' });
    expect(c.created).toBe(true);
  });

  it('refuses payloads containing secrets', async () => {
    await expect(enqueue({ token: 'abc' })).rejects.toThrow(/secret-like/);
    await expect(enqueue({ url: 'https://u:p@host/x' })).rejects.toThrow(/secret-like/);
  });

  it('records acceptance under the lease (deployment_trigger idempotency hook)', async () => {
    const { job } = await enqueue();
    await worker('w1', async (_j, ctx) => {
      expect(await ctx.recordAcceptance()).toBe(true);
    }).runOnce();
    expect((await get(job.id)).acceptanceRecordedAt).not.toBeNull();
  });

  it('survives a process restart: pending and stale jobs are picked up from the database', async () => {
    const { job } = await enqueue();
    await h.container.repos.jobs.claimNext('pre-restart', h.clock.now(), JOB_LEASE_TTL_MS, ['test_job']);
    const dataDir = h.dataDir;
    const config = h.config;
    await h.container.close();
    const restarted = await createHarness({ dataDir, config });
    restarted.clock.advance(JOB_LEASE_TTL_MS + 1000);
    const ran: string[] = [];
    const w = new JobWorker(
      restarted.container.repos.jobs,
      new Map([['test_job', async (j: Job) => void ran.push(j.id)]]),
      restarted.clock,
      restarted.container.logger,
      { workerId: 'post-restart' },
    );
    expect(await w.runOnce()).toBe(false); // reclaims the stale lease, backoff not yet elapsed
    restarted.clock.advance(retryDelayMs(1));
    expect(await w.runOnce()).toBe(true);
    expect(ran).toEqual([job.id]);
    await restarted.cleanup();
    h = await createHarness();
  });
});
