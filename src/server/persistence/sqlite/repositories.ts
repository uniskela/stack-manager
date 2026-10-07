import { and, asc, count, desc, eq, gt, inArray, lt, lte, ne, or } from 'drizzle-orm';
import type {
  AuditRepository,
  CredentialRepository,
  EnqueueJobInput,
  GitRepositoryConnectionRepository,
  JobRepository,
  Repositories,
  SessionRepository,
  SourceDraftRepository,
  StackRepository,
  UserRepository,
  WorkspaceRepository,
} from '@/server/application/ports';
import type { AuditEvent } from '@/server/domain/audit';
import type { CredentialRecord } from '@/server/domain/credential';
import type { SourceDraft } from '@/server/domain/draft';
import type { GitRepositoryConnection } from '@/server/domain/git-repository';
import type { Job } from '@/server/domain/job';
import type { Stack } from '@/server/domain/stack';
import type { User } from '@/server/domain/user';
import {
  auditEvents,
  gitRepositoryConnections,
  jobs,
  providerCredentials,
  sessions,
  sourceDrafts,
  stacks,
  users,
  workspaces,
} from '../schema';
import type { SqliteDb } from './database';

type UserRow = typeof users.$inferSelect;
type JobRow = typeof jobs.$inferSelect;

const toUser = (r: UserRow): User => ({
  id: r.id,
  username: r.username,
  role: r.role,
  gitAuthorName: r.gitAuthorName,
  gitAuthorEmail: r.gitAuthorEmail,
  createdAt: r.createdAt,
  lastLoginAt: r.lastLoginAt,
  disabledAt: r.disabledAt,
});

const toJob = (r: JobRow): Job => ({ ...r });

class SqliteUserRepository implements UserRepository {
  constructor(private readonly db: SqliteDb) {}

  async count() {
    return this.db.select({ n: count() }).from(users).get()?.n ?? 0;
  }

  async findById(id: string) {
    const row = this.db.select().from(users).where(eq(users.id, id)).get();
    return row ? toUser(row) : null;
  }

  async findByUsername(username: string) {
    const row = this.db.select().from(users).where(eq(users.username, username)).get();
    return row ? { ...toUser(row), passwordHash: row.passwordHash } : null;
  }

  async createFirstAdmin(user: Parameters<UserRepository['createFirstAdmin']>[0]) {
    // better-sqlite3 transactions are synchronous and serialised, so count+insert is atomic.
    return this.db.transaction((tx) => {
      const existing = tx.select({ n: count() }).from(users).get()?.n ?? 0;
      if (existing > 0) return null;
      tx.insert(users)
        .values({ ...user, updatedAt: user.createdAt })
        .run();
      return toUser({ ...user, updatedAt: user.createdAt });
    });
  }

  async recordLogin(id: string, at: Date) {
    this.db.update(users).set({ lastLoginAt: at, updatedAt: at }).where(eq(users.id, id)).run();
  }

  async updatePasswordHash(id: string, passwordHash: string, updatedAt: Date) {
    this.db.update(users).set({ passwordHash, updatedAt }).where(eq(users.id, id)).run();
  }

  async updateGitIdentity(id: string, identity: { name: string; email: string } | null, updatedAt: Date) {
    this.db
      .update(users)
      .set({
        gitAuthorName: identity?.name ?? null,
        gitAuthorEmail: identity?.email ?? null,
        updatedAt,
      })
      .where(eq(users.id, id))
      .run();
  }
}

class SqliteSessionRepository implements SessionRepository {
  constructor(private readonly db: SqliteDb) {}

  async insert(session: Parameters<SessionRepository['insert']>[0]) {
    this.db.insert(sessions).values(session).run();
  }

  async findActive(id: string, now: Date) {
    const row = this.db
      .select({ session: sessions, user: users })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(eq(sessions.id, id))
      .get();
    if (!row || row.session.expiresAt.getTime() <= now.getTime() || row.user.disabledAt) return null;
    return { session: row.session, user: toUser(row.user) };
  }

  async touch(id: string, lastSeenAt: Date, expiresAt: Date) {
    this.db.update(sessions).set({ lastSeenAt, expiresAt }).where(eq(sessions.id, id)).run();
  }

  async delete(id: string) {
    this.db.delete(sessions).where(eq(sessions.id, id)).run();
  }

  async deleteExpired(now: Date) {
    return this.db.delete(sessions).where(lte(sessions.expiresAt, now)).run().changes;
  }

  async listByUser(userId: string, now: Date) {
    return this.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.userId, userId), gt(sessions.expiresAt, now)))
      .orderBy(desc(sessions.lastSeenAt))
      .all();
  }

  async deleteForUser(userId: string, sessionId: string) {
    return (
      this.db
        .delete(sessions)
        .where(and(eq(sessions.userId, userId), eq(sessions.id, sessionId)))
        .run().changes > 0
    );
  }

  async deleteOtherSessions(userId: string, keepSessionId: string) {
    return this.db
      .delete(sessions)
      .where(and(eq(sessions.userId, userId), ne(sessions.id, keepSessionId)))
      .run().changes;
  }
}

class SqliteWorkspaceRepository implements WorkspaceRepository {
  constructor(private readonly db: SqliteDb) {}

  async insert(workspace: Parameters<WorkspaceRepository['insert']>[0]) {
    this.db.insert(workspaces).values(workspace).run();
  }

  async findById(id: string) {
    return this.db.select().from(workspaces).where(eq(workspaces.id, id)).get() ?? null;
  }

  async slugExists(slug: string) {
    return (
      this.db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.slug, slug)).get() !==
      undefined
    );
  }

  async list() {
    return this.db.select().from(workspaces).orderBy(asc(workspaces.createdAt)).all();
  }

  async update(id: string, patch: { name: string; updatedAt: Date }) {
    this.db.update(workspaces).set(patch).where(eq(workspaces.id, id)).run();
  }
}

class SqliteCredentialRepository implements CredentialRepository {
  constructor(private readonly db: SqliteDb) {}

  async insert(record: CredentialRecord) {
    this.db.insert(providerCredentials).values(record).run();
  }

  async findById(workspaceId: string, id: string) {
    return (
      this.db
        .select()
        .from(providerCredentials)
        .where(and(eq(providerCredentials.id, id), eq(providerCredentials.workspaceId, workspaceId)))
        .get() ?? null
    );
  }

  async list(workspaceId: string) {
    return this.db
      .select()
      .from(providerCredentials)
      .where(eq(providerCredentials.workspaceId, workspaceId))
      .orderBy(asc(providerCredentials.createdAt))
      .all();
  }

  async updateSecret(id: string, patch: Parameters<CredentialRepository['updateSecret']>[1]) {
    this.db
      .update(providerCredentials)
      // A new secret invalidates the previous connection-test result.
      .set({ ...patch, lastTestedAt: null, lastTestStatus: null, lastTestMessage: null })
      .where(eq(providerCredentials.id, id))
      .run();
  }

  async updateDetails(id: string, patch: Parameters<CredentialRepository['updateDetails']>[1]) {
    this.db.update(providerCredentials).set(patch).where(eq(providerCredentials.id, id)).run();
  }

  async recordTest(id: string, result: Parameters<CredentialRepository['recordTest']>[1]) {
    this.db
      .update(providerCredentials)
      .set({ lastTestedAt: result.at, lastTestStatus: result.status, lastTestMessage: result.message })
      .where(eq(providerCredentials.id, id))
      .run();
  }

  async countReferences(id: string) {
    return (
      this.db
        .select({ n: count() })
        .from(gitRepositoryConnections)
        .where(
          or(
            eq(gitRepositoryConnections.credentialId, id),
            eq(gitRepositoryConnections.webhookCredentialId, id),
          ),
        )
        .get()?.n ?? 0
    );
  }

  async delete(id: string) {
    this.db.delete(providerCredentials).where(eq(providerCredentials.id, id)).run();
  }
}

class SqliteGitRepositoryConnectionRepository implements GitRepositoryConnectionRepository {
  constructor(private readonly db: SqliteDb) {}

  async insert(conn: GitRepositoryConnection) {
    this.db.insert(gitRepositoryConnections).values(conn).run();
  }

  async findById(workspaceId: string, id: string) {
    return (
      this.db
        .select()
        .from(gitRepositoryConnections)
        .where(
          and(eq(gitRepositoryConnections.id, id), eq(gitRepositoryConnections.workspaceId, workspaceId)),
        )
        .get() ?? null
    );
  }

  async findByIdUnscoped(id: string) {
    return (
      this.db.select().from(gitRepositoryConnections).where(eq(gitRepositoryConnections.id, id)).get() ?? null
    );
  }

  async findByRemote(workspaceId: string, remoteUrl: string) {
    return (
      this.db
        .select()
        .from(gitRepositoryConnections)
        .where(
          and(
            eq(gitRepositoryConnections.workspaceId, workspaceId),
            eq(gitRepositoryConnections.remoteUrl, remoteUrl),
          ),
        )
        .get() ?? null
    );
  }

  async list(workspaceId: string) {
    return this.db
      .select()
      .from(gitRepositoryConnections)
      .where(eq(gitRepositoryConnections.workspaceId, workspaceId))
      .orderBy(asc(gitRepositoryConnections.createdAt))
      .all();
  }

  async update(id: string, patch: Parameters<GitRepositoryConnectionRepository['update']>[1]) {
    this.db.update(gitRepositoryConnections).set(patch).where(eq(gitRepositoryConnections.id, id)).run();
  }

  async delete(id: string) {
    this.db.delete(gitRepositoryConnections).where(eq(gitRepositoryConnections.id, id)).run();
  }
}

class SqliteJobRepository implements JobRepository {
  constructor(private readonly db: SqliteDb) {}

  async enqueue(input: EnqueueJobInput) {
    return this.db.transaction((tx) => {
      if (input.dedupeKey) {
        const active = tx
          .select()
          .from(jobs)
          .where(and(eq(jobs.dedupeKey, input.dedupeKey), inArray(jobs.status, ['pending', 'running'])))
          .get();
        if (active) return { job: toJob(active), created: false };
      }
      const row: JobRow = {
        id: input.id,
        type: input.type,
        payload: input.payload,
        status: 'pending',
        runAfter: input.runAfter,
        attempts: 0,
        maxAttempts: input.maxAttempts,
        lastError: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        acceptanceRecordedAt: null,
        dedupeKey: input.dedupeKey,
        createdAt: input.now,
        updatedAt: input.now,
        finishedAt: null,
      };
      tx.insert(jobs).values(row).run();
      return { job: toJob(row), created: true };
    });
  }

  async findById(id: string) {
    const row = this.db.select().from(jobs).where(eq(jobs.id, id)).get();
    return row ? toJob(row) : null;
  }

  async findLatestByDedupeKey(dedupeKey: string) {
    const row = this.db
      .select()
      .from(jobs)
      .where(eq(jobs.dedupeKey, dedupeKey))
      .orderBy(desc(jobs.createdAt))
      .get();
    return row ? toJob(row) : null;
  }

  async claimNext(owner: string, now: Date, leaseTtlMs: number, types: readonly string[]) {
    if (types.length === 0) return null;
    // Compare-and-set claim: portable to PostgreSQL (where SKIP LOCKED could replace the retry loop).
    for (let i = 0; i < 5; i++) {
      const candidate = this.db
        .select({ id: jobs.id })
        .from(jobs)
        .where(and(eq(jobs.status, 'pending'), lte(jobs.runAfter, now), inArray(jobs.type, [...types])))
        .orderBy(asc(jobs.runAfter), asc(jobs.createdAt))
        .get();
      if (!candidate) return null;
      const claimed = this.db
        .update(jobs)
        .set({
          status: 'running',
          leaseOwner: owner,
          leaseExpiresAt: new Date(now.getTime() + leaseTtlMs),
          heartbeatAt: now,
          updatedAt: now,
        })
        .where(and(eq(jobs.id, candidate.id), eq(jobs.status, 'pending')))
        .returning()
        .get();
      if (claimed) return toJob(claimed);
    }
    return null;
  }

  async heartbeat(id: string, owner: string, now: Date, leaseTtlMs: number) {
    return (
      this.db
        .update(jobs)
        .set({ heartbeatAt: now, leaseExpiresAt: new Date(now.getTime() + leaseTtlMs), updatedAt: now })
        .where(and(eq(jobs.id, id), eq(jobs.status, 'running'), eq(jobs.leaseOwner, owner)))
        .run().changes === 1
    );
  }

  private fenced(id: string, owner: string) {
    return and(eq(jobs.id, id), eq(jobs.status, 'running'), eq(jobs.leaseOwner, owner));
  }

  private static readonly clearLease = { leaseOwner: null, leaseExpiresAt: null, heartbeatAt: null } as const;

  async markSucceeded(id: string, owner: string, now: Date) {
    return (
      this.db
        .update(jobs)
        .set({
          status: 'succeeded',
          ...SqliteJobRepository.clearLease,
          updatedAt: now,
          finishedAt: now,
          lastError: null,
        })
        .where(this.fenced(id, owner))
        .run().changes === 1
    );
  }

  async markRetry(id: string, owner: string, now: Date, error: string, runAfter: Date) {
    const row = this.db.select({ attempts: jobs.attempts }).from(jobs).where(this.fenced(id, owner)).get();
    if (!row) return false;
    return (
      this.db
        .update(jobs)
        .set({
          status: 'pending',
          ...SqliteJobRepository.clearLease,
          attempts: row.attempts + 1,
          lastError: error,
          runAfter,
          updatedAt: now,
        })
        .where(this.fenced(id, owner))
        .run().changes === 1
    );
  }

  async markFailed(id: string, owner: string, now: Date, error: string, status: 'failed' | 'dead') {
    const row = this.db.select({ attempts: jobs.attempts }).from(jobs).where(this.fenced(id, owner)).get();
    if (!row) return false;
    return (
      this.db
        .update(jobs)
        .set({
          status,
          ...SqliteJobRepository.clearLease,
          attempts: row.attempts + 1,
          lastError: error,
          updatedAt: now,
          finishedAt: now,
        })
        .where(this.fenced(id, owner))
        .run().changes === 1
    );
  }

  async recordAcceptance(id: string, owner: string, now: Date) {
    return (
      this.db
        .update(jobs)
        .set({ acceptanceRecordedAt: now, updatedAt: now })
        .where(this.fenced(id, owner))
        .run().changes === 1
    );
  }

  async reclaimExpired(now: Date, backoffMs: (attempts: number) => number) {
    const stale = this.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.status, 'running'), lt(jobs.leaseExpiresAt, now)))
      .all();
    let requeued = 0;
    let dead = 0;
    for (const job of stale) {
      const attempts = job.attempts + 1;
      const exhausted = attempts >= job.maxAttempts;
      const changed = this.db
        .update(jobs)
        .set({
          status: exhausted ? 'dead' : 'pending',
          ...SqliteJobRepository.clearLease,
          attempts,
          runAfter: exhausted ? job.runAfter : new Date(now.getTime() + backoffMs(attempts)),
          lastError: 'Lease expired before the job completed (worker crash or restart); reclaimed.',
          updatedAt: now,
          finishedAt: exhausted ? now : null,
        })
        // CAS on the observed lease so a concurrent heartbeat wins.
        .where(
          and(
            eq(jobs.id, job.id),
            eq(jobs.status, 'running'),
            lt(jobs.leaseExpiresAt, now),
            job.leaseOwner === null ? undefined : eq(jobs.leaseOwner, job.leaseOwner),
          ),
        )
        .run().changes;
      if (changed === 1) {
        if (exhausted) dead++;
        else requeued++;
      }
    }
    return { requeued, dead };
  }
}

class SqliteAuditRepository implements AuditRepository {
  constructor(private readonly db: SqliteDb) {}

  async insert(event: AuditEvent) {
    this.db.insert(auditEvents).values(event).run();
  }

  async list(filter: { workspaceId?: string; limit: number }) {
    const q = this.db.select().from(auditEvents);
    const rows = (filter.workspaceId ? q.where(eq(auditEvents.workspaceId, filter.workspaceId)) : q)
      .orderBy(desc(auditEvents.createdAt))
      .limit(filter.limit)
      .all();
    return rows.map((r) => ({ ...r, action: r.action as AuditEvent['action'] }));
  }
}

class SqliteStackRepository implements StackRepository {
  constructor(private readonly db: SqliteDb) {}

  async insert(stack: Stack) {
    this.db.insert(stacks).values(stack).run();
  }

  async findById(workspaceId: string, id: string) {
    return (
      this.db
        .select()
        .from(stacks)
        .where(and(eq(stacks.id, id), eq(stacks.workspaceId, workspaceId)))
        .get() ?? null
    );
  }

  async list(workspaceId: string) {
    return this.db
      .select()
      .from(stacks)
      .where(eq(stacks.workspaceId, workspaceId))
      .orderBy(asc(stacks.name))
      .all();
  }

  async listByRepository(workspaceId: string, repositoryId: string) {
    return this.db
      .select()
      .from(stacks)
      .where(and(eq(stacks.workspaceId, workspaceId), eq(stacks.repositoryId, repositoryId)))
      .orderBy(asc(stacks.rootPath))
      .all();
  }

  async update(id: string, patch: Parameters<StackRepository['update']>[1]) {
    this.db.update(stacks).set(patch).where(eq(stacks.id, id)).run();
  }

  async delete(id: string) {
    this.db.delete(stacks).where(eq(stacks.id, id)).run();
  }
}

class SqliteSourceDraftRepository implements SourceDraftRepository {
  constructor(private readonly db: SqliteDb) {}

  async find(repositoryId: string, path: string) {
    return (
      this.db
        .select()
        .from(sourceDrafts)
        .where(and(eq(sourceDrafts.repositoryId, repositoryId), eq(sourceDrafts.path, path)))
        .get() ?? null
    );
  }

  async list(repositoryId: string, rootPath?: string) {
    const rows = this.db
      .select()
      .from(sourceDrafts)
      .where(eq(sourceDrafts.repositoryId, repositoryId))
      .orderBy(asc(sourceDrafts.path))
      .all();
    // Prefix filtering in application code keeps the query portable (no LIKE escaping differences).
    return rootPath ? rows.filter((r) => r.path === rootPath || r.path.startsWith(`${rootPath}/`)) : rows;
  }

  async upsert(draft: SourceDraft) {
    return this.db.transaction((tx) => {
      const existing = tx
        .select()
        .from(sourceDrafts)
        .where(and(eq(sourceDrafts.repositoryId, draft.repositoryId), eq(sourceDrafts.path, draft.path)))
        .get();
      if (!existing) {
        tx.insert(sourceDrafts).values(draft).run();
        return draft;
      }
      const next: SourceDraft = {
        ...existing,
        content: draft.content,
        baseBlobSha: draft.baseBlobSha,
        updatedByUserId: draft.updatedByUserId,
        updatedAt: draft.updatedAt,
      };
      tx.update(sourceDrafts)
        .set({
          content: next.content,
          baseBlobSha: next.baseBlobSha,
          updatedByUserId: next.updatedByUserId,
          updatedAt: next.updatedAt,
        })
        .where(eq(sourceDrafts.id, existing.id))
        .run();
      return next;
    });
  }

  async delete(repositoryId: string, path: string) {
    const result = this.db
      .delete(sourceDrafts)
      .where(and(eq(sourceDrafts.repositoryId, repositoryId), eq(sourceDrafts.path, path)))
      .run();
    return result.changes > 0;
  }
}

export function createSqliteRepositories(db: SqliteDb): Repositories {
  return {
    users: new SqliteUserRepository(db),
    sessions: new SqliteSessionRepository(db),
    workspaces: new SqliteWorkspaceRepository(db),
    credentials: new SqliteCredentialRepository(db),
    gitRepositories: new SqliteGitRepositoryConnectionRepository(db),
    jobs: new SqliteJobRepository(db),
    audit: new SqliteAuditRepository(db),
    stacks: new SqliteStackRepository(db),
    drafts: new SqliteSourceDraftRepository(db),
  };
}
