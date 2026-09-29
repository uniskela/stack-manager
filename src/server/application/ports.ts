import type { AuditEvent } from '@/server/domain/audit';
import type { CredentialRecord, CredentialTestStatus } from '@/server/domain/credential';
import type { SourceDraft } from '@/server/domain/draft';
import type { GitRepositoryConnection } from '@/server/domain/git-repository';
import type { Job } from '@/server/domain/job';
import type { Stack } from '@/server/domain/stack';
import type { Session, User, UserWithPasswordHash } from '@/server/domain/user';
import type { Workspace } from '@/server/domain/workspace';

/**
 * Persistence ports. Application services depend only on these interfaces; the SQLite/Drizzle
 * adapters live in `src/server/persistence/sqlite`. A PostgreSQL adapter implements the same ports.
 * All methods are async even though better-sqlite3 is synchronous, so adapters are interchangeable.
 */

export interface UserRepository {
  count(): Promise<number>;
  findById(id: string): Promise<User | null>;
  findByUsername(username: string): Promise<UserWithPasswordHash | null>;
  /** Atomically inserts the user only if no users exist yet. Returns null if setup already happened. */
  createFirstAdmin(user: UserWithPasswordHash): Promise<User | null>;
  recordLogin(id: string, at: Date): Promise<void>;
}

export interface SessionRepository {
  insert(session: Session): Promise<void>;
  findActive(id: string, now: Date): Promise<{ session: Session; user: User } | null>;
  touch(id: string, lastSeenAt: Date, expiresAt: Date): Promise<void>;
  delete(id: string): Promise<void>;
  deleteExpired(now: Date): Promise<number>;
}

export interface WorkspaceRepository {
  insert(workspace: Workspace): Promise<void>;
  findById(id: string): Promise<Workspace | null>;
  slugExists(slug: string): Promise<boolean>;
  list(): Promise<Workspace[]>;
  update(id: string, patch: { name: string; updatedAt: Date }): Promise<void>;
}

export interface CredentialRepository {
  insert(record: CredentialRecord): Promise<void>;
  findById(workspaceId: string, id: string): Promise<CredentialRecord | null>;
  list(workspaceId: string): Promise<CredentialRecord[]>;
  updateSecret(
    id: string,
    patch: Pick<
      CredentialRecord,
      'secretCiphertext' | 'secretNonce' | 'secretKeyVersion' | 'secretHint' | 'updatedAt'
    >,
  ): Promise<void>;
  updateDetails(
    id: string,
    patch: { label?: string; secretMeta?: Record<string, string>; updatedAt: Date },
  ): Promise<void>;
  recordTest(
    id: string,
    result: { at: Date; status: CredentialTestStatus; message: string | null },
  ): Promise<void>;
  countReferences(id: string): Promise<number>;
  delete(id: string): Promise<void>;
}

export interface GitRepositoryConnectionRepository {
  insert(conn: GitRepositoryConnection): Promise<void>;
  findById(workspaceId: string, id: string): Promise<GitRepositoryConnection | null>;
  /** Unscoped lookup for background jobs that carry only the connection id. */
  findByIdUnscoped(id: string): Promise<GitRepositoryConnection | null>;
  findByRemote(workspaceId: string, remoteUrl: string): Promise<GitRepositoryConnection | null>;
  list(workspaceId: string): Promise<GitRepositoryConnection[]>;
  update(
    id: string,
    patch: Partial<
      Pick<
        GitRepositoryConnection,
        | 'name'
        | 'defaultBranch'
        | 'credentialId'
        | 'syncStatus'
        | 'lastSyncError'
        | 'headSha'
        | 'lastFetchedAt'
        | 'autoAddStacks'
      >
    > & { updatedAt: Date },
  ): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface EnqueueJobInput {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  runAfter: Date;
  maxAttempts: number;
  dedupeKey: string | null;
  now: Date;
}

export interface JobRepository {
  /** Inserts a pending job. If `dedupeKey` matches an active (pending/running) job, returns that job instead. */
  enqueue(input: EnqueueJobInput): Promise<{ job: Job; created: boolean }>;
  findById(id: string): Promise<Job | null>;
  findLatestByDedupeKey(dedupeKey: string): Promise<Job | null>;
  /** Atomically claims the next due pending job, setting status=running and lease fields. */
  claimNext(owner: string, now: Date, leaseTtlMs: number, types: readonly string[]): Promise<Job | null>;
  /** Extends the lease if `owner` still holds it. Returns false if the lease was lost. */
  heartbeat(id: string, owner: string, now: Date, leaseTtlMs: number): Promise<boolean>;
  /** Terminal/retry transitions are fenced on `leaseOwner`; they return false if the lease was lost. */
  markSucceeded(id: string, owner: string, now: Date): Promise<boolean>;
  markRetry(id: string, owner: string, now: Date, error: string, runAfter: Date): Promise<boolean>;
  markFailed(
    id: string,
    owner: string,
    now: Date,
    error: string,
    status: 'failed' | 'dead',
  ): Promise<boolean>;
  recordAcceptance(id: string, owner: string, now: Date): Promise<boolean>;
  /**
   * Requeues running jobs whose lease expired (crash/restart recovery, ADR 0002): status=pending,
   * lease cleared, attempts+1, runAfter backoff; jobs out of attempts become `dead`.
   */
  reclaimExpired(
    now: Date,
    backoffMs: (attempts: number) => number,
  ): Promise<{ requeued: number; dead: number }>;
}

export interface AuditRepository {
  insert(event: AuditEvent): Promise<void>;
  list(filter: { workspaceId?: string; limit: number }): Promise<AuditEvent[]>;
}

export interface StackRepository {
  insert(stack: Stack): Promise<void>;
  findById(workspaceId: string, id: string): Promise<Stack | null>;
  list(workspaceId: string): Promise<Stack[]>;
  listByRepository(workspaceId: string, repositoryId: string): Promise<Stack[]>;
  update(
    id: string,
    patch: Partial<Pick<Stack, 'name' | 'composePath'>> & { updatedAt: Date },
  ): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface SourceDraftRepository {
  find(repositoryId: string, path: string): Promise<SourceDraft | null>;
  /** Drafts of a repository, optionally only those at or under `rootPath`. */
  list(repositoryId: string, rootPath?: string): Promise<SourceDraft[]>;
  /** Inserts or replaces the draft for (repositoryId, path). Keeps the original id/createdAt/base commit. */
  upsert(draft: SourceDraft): Promise<SourceDraft>;
  delete(repositoryId: string, path: string): Promise<boolean>;
}

export interface Repositories {
  users: UserRepository;
  sessions: SessionRepository;
  workspaces: WorkspaceRepository;
  credentials: CredentialRepository;
  gitRepositories: GitRepositoryConnectionRepository;
  jobs: JobRepository;
  audit: AuditRepository;
  stacks: StackRepository;
  drafts: SourceDraftRepository;
}
