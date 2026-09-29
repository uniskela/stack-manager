import { randomUUID } from 'node:crypto';
import os from 'node:os';
import type { JobRepository } from '@/server/application/ports';
import type { Clock } from '@/server/domain/clock';
import {
  JOB_HEARTBEAT_INTERVAL_MS,
  JOB_LEASE_TTL_MS,
  JOB_POLL_INTERVAL_MS,
  PermanentJobError,
  retryDelayMs,
  type Job,
} from '@/server/domain/job';
import type { Logger } from '@/server/observability/logger';
import { safeErrorMessage } from '@/server/security/redact';

export interface JobContext {
  /** Aborted when the worker stops or the lease is lost; handlers should pass it to I/O. */
  signal: AbortSignal;
  logger: Logger;
  /** For side-effecting handlers (deployment_trigger): record provider acceptance before completing. */
  recordAcceptance(): Promise<boolean>;
}

export type JobHandler = (job: Job, ctx: JobContext) => Promise<void>;

export interface JobWorkerOptions {
  workerId?: string;
  leaseTtlMs?: number;
  heartbeatIntervalMs?: number;
  pollIntervalMs?: number;
}

/**
 * In-process worker for the persisted job table (ADR 0002). Single concurrency by design for the
 * single-instance MVP. Recovery is DB-driven: every poll first reclaims `running` jobs whose lease
 * expired, so a crash or restart never strands work.
 */
export class JobWorker {
  readonly workerId: string;
  readonly #leaseTtlMs: number;
  readonly #heartbeatMs: number;
  readonly #pollMs: number;
  #running = false;
  #loop: Promise<void> | null = null;
  #current: AbortController | null = null;
  #wake: (() => void) | null = null;

  constructor(
    private readonly repo: JobRepository,
    private readonly handlers: ReadonlyMap<string, JobHandler>,
    private readonly clock: Clock,
    private readonly logger: Logger,
    options: JobWorkerOptions = {},
  ) {
    this.workerId = options.workerId ?? `${os.hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
    this.#leaseTtlMs = options.leaseTtlMs ?? JOB_LEASE_TTL_MS;
    this.#heartbeatMs = options.heartbeatIntervalMs ?? JOB_HEARTBEAT_INTERVAL_MS;
    this.#pollMs = options.pollIntervalMs ?? JOB_POLL_INTERVAL_MS;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.logger.info('job worker started', { workerId: this.workerId, types: [...this.handlers.keys()] });
    this.#loop = (async () => {
      while (this.#running) {
        let processed = false;
        try {
          processed = await this.runOnce();
        } catch (error) {
          this.logger.error('job worker poll failed', { error });
        }
        if (!processed && this.#running) await this.#sleep(this.#pollMs);
      }
    })();
  }

  /** Wakes the poller immediately (e.g. right after enqueueing interactive work). */
  nudge(): void {
    this.#wake?.();
  }

  async stop(): Promise<void> {
    this.#running = false;
    this.#wake?.();
    this.#current?.abort(new Error('worker stopping'));
    await this.#loop;
    this.logger.info('job worker stopped', { workerId: this.workerId });
  }

  /** Reclaims stale leases, then claims and runs at most one job. Returns true if a job ran. */
  async runOnce(): Promise<boolean> {
    const reclaimed = await this.repo.reclaimExpired(this.clock.now(), retryDelayMs);
    if (reclaimed.requeued || reclaimed.dead) this.logger.warn('reclaimed expired job leases', reclaimed);

    const job = await this.repo.claimNext(this.workerId, this.clock.now(), this.#leaseTtlMs, [
      ...this.handlers.keys(),
    ]);
    if (!job) return false;
    await this.#execute(job);
    return true;
  }

  async #execute(job: Job): Promise<void> {
    const handler = this.handlers.get(job.type)!;
    const log = this.logger.child({ jobId: job.id, jobType: job.type, attempt: job.attempts + 1 });
    const controller = new AbortController();
    this.#current = controller;
    let leaseLost = false;

    const heartbeat = setInterval(() => {
      this.repo
        .heartbeat(job.id, this.workerId, this.clock.now(), this.#leaseTtlMs)
        .then((ok) => {
          if (!ok && !leaseLost) {
            leaseLost = true;
            log.warn('job lease lost; aborting handler');
            controller.abort(new Error('lease lost'));
          }
        })
        .catch((error) => log.error('job heartbeat failed', { error }));
    }, this.#heartbeatMs);
    heartbeat.unref?.();

    try {
      await handler(job, {
        signal: controller.signal,
        logger: log,
        recordAcceptance: () => this.repo.recordAcceptance(job.id, this.workerId, this.clock.now()),
      });
      if (!(await this.repo.markSucceeded(job.id, this.workerId, this.clock.now()))) {
        log.warn('job finished after its lease was lost; result not recorded');
      } else {
        log.info('job succeeded');
      }
    } catch (error) {
      const message = safeErrorMessage(error);
      const now = this.clock.now();
      const attempts = job.attempts + 1;
      if (error instanceof PermanentJobError) {
        await this.repo.markFailed(job.id, this.workerId, now, message, 'failed');
        log.warn('job failed permanently', { error: message });
      } else if (attempts >= job.maxAttempts) {
        await this.repo.markFailed(job.id, this.workerId, now, message, 'dead');
        log.error('job exhausted retries; moved to dead', { error: message });
      } else {
        const runAfter = new Date(now.getTime() + retryDelayMs(attempts));
        await this.repo.markRetry(job.id, this.workerId, now, message, runAfter);
        log.warn('job failed; will retry', { error: message, runAfter });
      }
    } finally {
      clearInterval(heartbeat);
      this.#current = null;
    }
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#wake = null;
        resolve();
      }, ms);
      timer.unref?.();
      this.#wake = () => {
        clearTimeout(timer);
        this.#wake = null;
        resolve();
      };
    });
  }
}
