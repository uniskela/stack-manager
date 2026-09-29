import type { Clock } from '@/server/domain/clock';
import { JOB_DEFAULT_MAX_ATTEMPTS, type Job } from '@/server/domain/job';
import { redact } from '@/server/security/redact';
import type { JobRepository } from './ports';

/**
 * `JobEnqueue` port from ADR 0002. Payloads carry references (ids), never secrets: a payload that
 * would be altered by redaction is rejected outright rather than silently stored.
 */
export class JobQueue {
  constructor(
    private readonly repo: JobRepository,
    private readonly clock: Clock,
    private readonly newId: () => string,
  ) {}

  async enqueue(
    type: string,
    payload: Record<string, unknown>,
    options: { dedupeKey?: string; delayMs?: number; maxAttempts?: number } = {},
  ): Promise<{ job: Job; created: boolean }> {
    if (JSON.stringify(redact(payload)) !== JSON.stringify(payload)) {
      throw new Error(`Job payload for "${type}" contains secret-like data; pass references instead.`);
    }
    const now = this.clock.now();
    return this.repo.enqueue({
      id: this.newId(),
      type,
      payload,
      runAfter: new Date(now.getTime() + (options.delayMs ?? 0)),
      maxAttempts: options.maxAttempts ?? JOB_DEFAULT_MAX_ATTEMPTS,
      dedupeKey: options.dedupeKey ?? null,
      now,
    });
  }

  get(id: string): Promise<Job | null> {
    return this.repo.findById(id);
  }

  latestFor(dedupeKey: string): Promise<Job | null> {
    return this.repo.findLatestByDedupeKey(dedupeKey);
  }
}
