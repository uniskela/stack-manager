import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * Physical schema for the PR #2 foundation entities and the PR #3 source workspace (docs/domain/DATA_MODEL.md).
 *
 * Portability rules (keep a PostgreSQL port practical):
 * - ids are application-generated UUID strings, never autoincrement integers;
 * - timestamps are integer epoch milliseconds set by the application clock, not SQL defaults;
 * - JSON is stored as text and (de)serialised by the application;
 * - no SQLite-only functions are used in queries.
 */

const ts = (name: string) => integer(name, { mode: 'timestamp_ms' });

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    username: text('username').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: text('role', { enum: ['admin'] }).notNull(),
    /** Author name for commits created by Stack Manager; null until the user configures it. */
    gitAuthorName: text('git_author_name'),
    /** Author email for commits created by Stack Manager; null until the user configures it. */
    gitAuthorEmail: text('git_author_email'),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
    lastLoginAt: ts('last_login_at'),
    disabledAt: ts('disabled_at'),
  },
  (t) => [uniqueIndex('users_username_uq').on(t.username)],
);

export const sessions = sqliteTable(
  'sessions',
  {
    /** HMAC-SHA256 of the cookie token keyed by STACK_MANAGER_SESSION_SECRET. The raw token is never stored. */
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: ts('created_at').notNull(),
    lastSeenAt: ts('last_seen_at').notNull(),
    expiresAt: ts('expires_at').notNull(),
    userAgent: text('user_agent'),
  },
  (t) => [index('sessions_user_idx').on(t.userId), index('sessions_expires_idx').on(t.expiresAt)],
);

export const workspaces = sqliteTable(
  'workspaces',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [uniqueIndex('workspaces_slug_uq').on(t.slug)],
);

export const providerCredentials = sqliteTable(
  'provider_credentials',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['git', 'deployment', 'runtime', 'secret'] }).notNull(),
    providerType: text('provider_type').notNull(),
    label: text('label').notNull(),
    /** AES-256-GCM ciphertext||tag, base64. Never returned by any API. */
    secretCiphertext: text('secret_ciphertext').notNull(),
    secretNonce: text('secret_nonce').notNull(),
    secretKeyVersion: integer('secret_key_version').notNull(),
    /** Masked hint such as "••••a1b2"; safe to display. */
    secretHint: text('secret_hint').notNull(),
    /** Non-secret metadata only (e.g. username hint). */
    secretMeta: text('secret_meta', { mode: 'json' }).$type<Record<string, string>>().notNull(),
    lastTestedAt: ts('last_tested_at'),
    lastTestStatus: text('last_test_status', { enum: ['ok', 'failed'] }),
    lastTestMessage: text('last_test_message'),
    createdByUserId: text('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [index('provider_credentials_workspace_idx').on(t.workspaceId)],
);

export const gitRepositoryConnections = sqliteTable(
  'git_repository_connections',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    gitProviderType: text('git_provider_type').notNull(),
    remoteUrl: text('remote_url').notNull(),
    defaultBranch: text('default_branch').notNull(),
    credentialId: text('credential_id').references(() => providerCredentials.id, { onDelete: 'restrict' }),
    webhookCredentialId: text('webhook_credential_id').references(() => providerCredentials.id, {
      onDelete: 'restrict',
    }),
    /** Relative to STACK_MANAGER_DATA_DIR, e.g. "repos/<id>". */
    localClonePath: text('local_clone_path').notNull(),
    syncStatus: text('sync_status', { enum: ['pending', 'syncing', 'ready', 'error'] }).notNull(),
    lastSyncError: text('last_sync_error'),
    headSha: text('head_sha'),
    lastFetchedAt: ts('last_fetched_at'),
    /** Register every Compose folder as a stack after each successful fetch. */
    autoAddStacks: integer('auto_add_stacks', { mode: 'boolean' }).notNull().default(true),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [
    index('git_repo_workspace_idx').on(t.workspaceId),
    uniqueIndex('git_repo_workspace_remote_uq').on(t.workspaceId, t.remoteUrl),
  ],
);

export const jobs = sqliteTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    type: text('type').notNull(),
    /** Redacted JSON payload. Handlers resolve secrets by reference at run time. */
    payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    status: text('status', { enum: ['pending', 'running', 'succeeded', 'failed', 'dead'] }).notNull(),
    runAfter: ts('run_after').notNull(),
    attempts: integer('attempts').notNull(),
    maxAttempts: integer('max_attempts').notNull(),
    lastError: text('last_error'),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: ts('lease_expires_at'),
    heartbeatAt: ts('heartbeat_at'),
    acceptanceRecordedAt: ts('acceptance_recorded_at'),
    /** Optional idempotency key: enqueueing the same key twice while active returns the existing job. */
    dedupeKey: text('dedupe_key'),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
    finishedAt: ts('finished_at'),
  },
  (t) => [
    index('jobs_claim_idx').on(t.status, t.runAfter),
    index('jobs_lease_idx').on(t.status, t.leaseExpiresAt),
    uniqueIndex('jobs_dedupe_active_uq')
      .on(t.dedupeKey)
      .where(sql`${t.dedupeKey} IS NOT NULL AND ${t.status} IN ('pending', 'running')`),
  ],
);

export const auditEvents = sqliteTable(
  'audit_events',
  {
    id: text('id').primaryKey(),
    createdAt: ts('created_at').notNull(),
    actorUserId: text('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    workspaceId: text('workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    outcome: text('outcome', { enum: ['success', 'failure'] }).notNull(),
    entityType: text('entity_type'),
    entityId: text('entity_id'),
    /** Always passed through the redactor before insert. */
    meta: text('meta', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  },
  (t) => [
    index('audit_created_idx').on(t.createdAt),
    index('audit_workspace_idx').on(t.workspaceId, t.createdAt),
  ],
);

/** PR #3: explicit stacks inside a connected repository (docs/STACK_DISCOVERY.md). */
export const stacks = sqliteTable(
  'stacks',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    repositoryId: text('repository_id')
      .notNull()
      .references(() => gitRepositoryConnections.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    /** Repo-relative directory; '' is the repository root. */
    rootPath: text('root_path').notNull(),
    /** Repo-relative path of the primary Compose file. */
    composePath: text('compose_path').notNull(),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [
    index('stacks_workspace_idx').on(t.workspaceId),
    uniqueIndex('stacks_repo_root_uq').on(t.repositoryId, t.rootPath),
    uniqueIndex('stacks_repo_slug_uq').on(t.repositoryId, t.slug),
  ],
);

/** Pending edits to repository files; the Git workflow commits selected drafts without deleting them. */
export const sourceDrafts = sqliteTable(
  'source_drafts',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    repositoryId: text('repository_id')
      .notNull()
      .references(() => gitRepositoryConnections.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    content: text('content').notNull(),
    /** Null for a new file. */
    baseBlobSha: text('base_blob_sha'),
    baseCommitSha: text('base_commit_sha').notNull(),
    createdByUserId: text('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    updatedByUserId: text('updated_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [uniqueIndex('source_drafts_repo_path_uq').on(t.repositoryId, t.path)],
);
