import type { JobQueue } from '@/server/application/job-queue';
import type { GitRepositoryConnectionRepository, WorkspaceRepository } from '@/server/application/ports';
import { REPOSITORY_SYNC_JOB } from '@/server/application/git-repository-service';
import type { Clock } from '@/server/domain/clock';
import type { GitRepositoryConnection } from '@/server/domain/git-repository';
import type { Logger } from '@/server/observability/logger';
import { safeErrorMessage } from '@/server/security/redact';

export const AUTO_FETCH_POLL_INTERVAL_MS = 60_000;

type FetchState = Pick<
  GitRepositoryConnection,
  'lastSyncAttemptAt' | 'lastSyncFailedAt' | 'lastFetchedAt' | 'createdAt'
>;

/**
 * Determine when background fetching is due without depending on the browser.
 * A failed attempt waits a full interval from the failure; successful checks
 * wait from their last fetch even when the remote SHA has not changed.
 */
export function isRepositoryAutoFetchDue(repository: FetchState, now: Date, intervalMs: number): boolean {
  // Active jobs dedupe in SQLite; stale repository status must not strand interrupted work.
  const lastAttempt = Math.max(
    repository.lastSyncAttemptAt?.getTime() ?? 0,
    repository.lastSyncFailedAt?.getTime() ?? 0,
    repository.lastFetchedAt?.getTime() ?? repository.createdAt.getTime(),
  );
  return now.getTime() - lastAttempt >= intervalMs;
}

/**
 * Low-cost, single-process scheduler. Work is not held in memory: each tick
 * enqueues existing durable repository_sync jobs, which are deduplicated by
 * the database and recovered by JobWorker after restarts.
 */
export class RepositoryAutoFetch {
  readonly #intervalMs: number;
  #timer: ReturnType<typeof setInterval> | null = null;
  #inFlight: Promise<number> | null = null;
  #stopping = false;

  constructor(
    private readonly workspaces: Pick<WorkspaceRepository, 'list'>,
    private readonly repositories: Pick<GitRepositoryConnectionRepository, 'list'>,
    private readonly jobs: Pick<JobQueue, 'enqueue'>,
    private readonly clock: Clock,
    private readonly logger: Pick<Logger, 'debug' | 'warn'>,
    intervalMinutes: number,
  ) {
    if (!Number.isInteger(intervalMinutes) || intervalMinutes < 5 || intervalMinutes > 1440) {
      throw new Error('Automatic fetch interval must be 5–1440 minutes.');
    }
    this.#intervalMs = intervalMinutes * 60_000;
  }

  /** Safe for manual tests and overlapping timer ticks. */
  runOnce(): Promise<number> {
    if (this.#stopping) return Promise.resolve(0);
    if (this.#inFlight) return this.#inFlight;
    const attempt = this.#scan();
    this.#inFlight = attempt;
    void attempt.then(
      () => {
        if (this.#inFlight === attempt) this.#inFlight = null;
      },
      () => {
        if (this.#inFlight === attempt) this.#inFlight = null;
      },
    );
    return attempt;
  }

  start(): void {
    if (this.#timer) return;
    this.#stopping = false;
    void this.runOnce().catch((error) =>
      this.logger.warn('automatic repository fetch scan failed', { error: safeErrorMessage(error) }),
    );
    this.#timer = setInterval(() => {
      void this.runOnce().catch((error) =>
        this.logger.warn('automatic repository fetch scan failed', { error: safeErrorMessage(error) }),
      );
    }, AUTO_FETCH_POLL_INTERVAL_MS);
    this.#timer.unref();
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    await this.#inFlight?.catch(() => undefined);
  }

  async #scan(): Promise<number> {
    let queued = 0;
    for (const workspace of await this.workspaces.list()) {
      if (this.#stopping) break;
      let repositories;
      try {
        repositories = await this.repositories.list(workspace.id);
      } catch (error) {
        this.logger.warn('automatic repository fetch workspace lookup failed', {
          workspaceId: workspace.id,
          error: safeErrorMessage(error),
        });
        continue;
      }
      for (const repository of repositories) {
        if (this.#stopping) break;
        if (!isRepositoryAutoFetchDue(repository, this.clock.now(), this.#intervalMs)) continue;
        try {
          const { created } = await this.jobs.enqueue(
            REPOSITORY_SYNC_JOB,
            { repositoryId: repository.id, requestedBy: null },
            { dedupeKey: `${REPOSITORY_SYNC_JOB}:${repository.id}` },
          );
          if (created) {
            queued++;
            this.logger.debug('scheduled repository fetch', { repositoryId: repository.id });
          }
        } catch (error) {
          this.logger.warn('could not schedule repository fetch', {
            repositoryId: repository.id,
            error: safeErrorMessage(error),
          });
        }
      }
    }
    return queued;
  }
}
