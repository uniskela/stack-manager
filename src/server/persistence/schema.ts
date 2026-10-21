import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * Physical schema for the PR #2 foundation entities and the PR #3 source workspace (docs/internal/domain/DATA_MODEL.md).
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
    kind: text('kind', { enum: ['git', 'git_webhook', 'deployment', 'runtime', 'secret'] }).notNull(),
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
    lastSyncAttemptAt: ts('last_sync_attempt_at'),
    lastSyncFailedAt: ts('last_sync_failed_at'),
    lastHeadChangedAt: ts('last_head_changed_at'),
    /** Register every Compose folder as a stack after each successful fetch. */
    autoAddStacks: integer('auto_add_stacks', { mode: 'boolean' }).notNull().default(true),
    autoFetchEnabled: integer('auto_fetch_enabled', { mode: 'boolean' }).notNull().default(true),
    autoFetchIntervalMinutes: integer('auto_fetch_interval_minutes'),
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
    followUpRequested: integer('follow_up_requested', { mode: 'boolean' }).notNull().default(false),
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

/** PR #3: explicit stacks inside a connected repository (docs/public/STACK_DISCOVERY.md). */
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

/** No payloads or signing material. Delivery IDs survive restarts for replay protection. */
export const gitWebhookDeliveries = sqliteTable(
  'git_webhook_deliveries',
  {
    id: text('id').primaryKey(),
    repositoryId: text('repository_id')
      .notNull()
      .references(() => gitRepositoryConnections.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    deliveryId: text('delivery_id').notNull(),
    eventType: text('event_type').notNull(),
    bodyHash: text('body_hash'),
    afterSha: text('after_sha'),
    activeStackIds: text('active_stack_ids', { mode: 'json' }).$type<string[]>().notNull().default([]),
    signingCredentialId: text('signing_credential_id'),
    signingNonce: text('signing_nonce'),
    processedAt: ts('processed_at'),
    ref: text('ref'),
    receivedAt: ts('received_at').notNull(),
    status: text('status', { enum: ['accepted', 'ignored'] }).notNull(),
    jobId: text('job_id').references(() => jobs.id, { onDelete: 'restrict' }),
  },
  (t) => [
    uniqueIndex('git_webhook_delivery_uq').on(t.repositoryId, t.provider, t.deliveryId),
    uniqueIndex('git_webhook_body_uq').on(t.repositoryId, t.provider, t.bodyHash),
    index('git_webhook_received_idx').on(t.repositoryId, t.receivedAt),
  ],
);

export const deploymentBindings = sqliteTable(
  'deployment_bindings',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    stackId: text('stack_id')
      .notNull()
      .references(() => stacks.id, { onDelete: 'cascade' }),
    providerType: text('provider_type', { enum: ['portainer-webhook', 'generic-webhook'] }).notNull(),
    credentialId: text('credential_id')
      .notNull()
      .references(() => providerCredentials.id, { onDelete: 'restrict' }),
    managedCredential: integer('managed_credential', { mode: 'boolean' }).notNull().default(false),
    enabled: integer('enabled', { mode: 'boolean' }).notNull(),
    deployOnPush: integer('deploy_on_push', { mode: 'boolean' }).notNull().default(false),
    revision: text('revision').notNull(),
    routingPolicy: text('routing_policy', { mode: 'json' }).$type<
      import('@/shared/deployment-routing').RoutingPolicy
    >(),
    routingHeadSha: text('routing_head_sha'),
    routingBranch: text('routing_branch'),
    automationHold: integer('automation_hold', { mode: 'boolean' }).notNull().default(false),
    lastAttemptAt: ts('last_attempt_at'),
    lastAcceptedAt: ts('last_accepted_at'),
    lastFailedAt: ts('last_failed_at'),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [uniqueIndex('deployment_binding_stack_uq').on(t.stackId)],
);

export const deploymentAttempts = sqliteTable(
  'deployment_attempts',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    stackId: text('stack_id')
      .notNull()
      .references(() => stacks.id, { onDelete: 'cascade' }),
    bindingId: text('binding_id').notNull(),
    providerType: text('provider_type', { enum: ['portainer-webhook', 'generic-webhook'] }).notNull(),
    actorUserId: text('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    triggerType: text('trigger_type', { enum: ['manual', 'automatic'] }).notNull(),
    requestedAt: ts('requested_at').notNull(),
    status: text('status', { enum: ['queued', 'running', 'accepted', 'rejected', 'unknown'] }).notNull(),
    httpStatus: integer('http_status'),
    reason: text('reason'),
    completedAt: ts('completed_at'),
    bindingRevision: text('binding_revision').notNull(),
    credentialNonce: text('credential_nonce').notNull(),
    acknowledgedAt: ts('acknowledged_at'),
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'restrict' }),
  },
  (t) => [
    index('deployment_attempt_history_idx').on(t.stackId, t.requestedAt),
    uniqueIndex('deployment_attempt_active_uq')
      .on(t.stackId)
      .where(sql`${t.status} IN ('queued','running')`),
  ],
);

/** Safe explanations only; no webhook URLs, credentials or request bodies. */
export const deploymentRoutingDecisions = sqliteTable(
  'deployment_routing_decisions',
  {
    id: text('id').primaryKey(),
    repositoryId: text('repository_id')
      .notNull()
      .references(() => gitRepositoryConnections.id, { onDelete: 'cascade' }),
    sourceDeliveryId: text('source_delivery_id')
      .notNull()
      .references(() => gitWebhookDeliveries.id, { onDelete: 'cascade' }),
    stackId: text('stack_id')
      .notNull()
      .references(() => stacks.id, { onDelete: 'cascade' }),
    bindingRevision: text('binding_revision'),
    beforeSha: text('before_sha'),
    afterSha: text('after_sha').notNull(),
    matchedPaths: text('matched_paths', { mode: 'json' }).$type<string[]>().notNull(),
    decision: text('decision', { enum: ['deploy', 'skip', 'blocked'] }).notNull(),
    reasonCode: text('reason_code').notNull(),
    explanation: text('explanation').notNull(),
    attemptId: text('attempt_id').references(() => deploymentAttempts.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').notNull(),
    processedAt: ts('processed_at').notNull(),
  },
  (t) => [
    uniqueIndex('deployment_routing_source_stack_uq').on(t.sourceDeliveryId, t.stackId),
    index('deployment_routing_history_idx').on(t.stackId, t.createdAt),
  ],
);
