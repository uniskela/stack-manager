/**
 * In-memory fixed-window limiter for login/setup attempts. Single-process by design (ADR 0004);
 * a restart resets counters, which is acceptable for a self-hosted single-operator app.
 */
export class AttemptLimiter {
  readonly #buckets = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly maxAttempts: number,
    private readonly windowMs: number,
  ) {}

  isBlocked(key: string, now = Date.now()): boolean {
    const bucket = this.#buckets.get(key);
    if (!bucket) return false;
    if (bucket.resetAt <= now) {
      this.#buckets.delete(key);
      return false;
    }
    return bucket.count >= this.maxAttempts;
  }

  recordFailure(key: string, now = Date.now()): void {
    const bucket = this.#buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      this.#buckets.set(key, { count: 1, resetAt: now + this.windowMs });
    } else {
      bucket.count++;
    }
    if (this.#buckets.size > 10_000) this.#prune(now);
  }

  reset(key: string): void {
    this.#buckets.delete(key);
  }

  #prune(now: number): void {
    for (const [k, b] of this.#buckets) if (b.resetAt <= now) this.#buckets.delete(k);
  }
}
