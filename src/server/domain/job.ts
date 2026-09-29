export type JobStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'dead';

export interface Job<P extends Record<string, unknown> = Record<string, unknown>> {
  id: string;
  type: string;
  payload: P;
  status: JobStatus;
  runAfter: Date;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  heartbeatAt: Date | null;
  acceptanceRecordedAt: Date | null;
  dedupeKey: string | null;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
}

/** Job lease/heartbeat constants (docs/adr/0002-persisted-jobs.md). */
export const JOB_LEASE_TTL_MS = 60_000;
export const JOB_HEARTBEAT_INTERVAL_MS = 10_000;
export const JOB_POLL_INTERVAL_MS = 1_000;
export const JOB_DEFAULT_MAX_ATTEMPTS = 5;

/** Exponential backoff: 5s, 10s, 20s … capped at 15 minutes. */
export function retryDelayMs(attempts: number): number {
  return Math.min(5_000 * 2 ** Math.max(0, attempts - 1), 15 * 60_000);
}

/** Signals that retrying cannot help (bad input, missing record). The job becomes `failed`, not `dead`. */
export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentJobError';
  }
}
