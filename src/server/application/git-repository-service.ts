import fs from 'node:fs/promises';
import path from 'node:path';
import type { Clock } from '@/server/domain/clock';
import type { CredentialView } from '@/server/domain/credential';
import { ConflictError, NotFoundError, ValidationError } from '@/server/domain/errors';
import {
  normalizeRemoteUrl,
  repositoryNameFromUrl,
  validateBranchName,
  validateRepositoryName,
  type GitRepositoryConnection,
} from '@/server/domain/git-repository';
import { PermanentJobError, type Job } from '@/server/domain/job';
import type { Logger } from '@/server/observability/logger';
import type { GitProviderRegistry } from '@/server/providers/git/registry';
import {
  GitOperationError,
  type GitHttpAuth,
  type GitProvider,
  type RemoteProbe,
} from '@/server/providers/git/types';
import { assertAllowedHost, type Resolver } from '@/server/security/network-policy';
import { resolveRealWithin, resolveWithin } from '@/server/security/paths';
import { safeErrorMessage } from '@/server/security/redact';
import { DecryptionError } from '@/server/security/secret-box';
import type { AuditService } from './audit-service';
import type { CredentialService } from './credential-service';
import type { JobQueue } from './job-queue';
import type { GitRepositoryConnectionRepository } from './ports';

export const REPOSITORY_SYNC_JOB = 'repository_sync';

export type RepositoryAuthInput =
  | { type: 'none' }
  | { type: 'credential'; credentialId: string }
  | { type: 'token'; token: string; username?: string; label?: string };

export interface RepositoryView {
  id: string;
  workspaceId: string;
  name: string;
  gitProviderType: string;
  providerName: string;
  remoteUrl: string;
  defaultBranch: string;
  credential: CredentialView | null;
  syncStatus: GitRepositoryConnection['syncStatus'];
  lastSyncError: string | null;
  headSha: string | null;
  lastFetchedAt: string | null;
  createdAt: string;
  sync: { status: Job['status']; attempts: number; runAfter: string } | null;
}

export type ConnectionTestResult =
  | { ok: true; defaultBranch: string | null; branches: string[]; branchCount: number }
  | { ok: false; reason: GitOperationError['kind'] | 'credential'; message: string };

export interface GitRepositoryServiceOptions {
  dataDir: string;
  reposDir: string;
  allowPrivateNetworks: boolean;
  resolver?: Resolver;
}

/**
 * Repository connections: validation, access tests, clone/fetch under the data directory and
 * branch metadata. Commit/push UX is PR #4; this service only keeps a local mirror current.
 */
export class GitRepositoryService {
  constructor(
    private readonly repo: GitRepositoryConnectionRepository,
    private readonly credentials: CredentialService,
    private readonly providers: GitProviderRegistry,
    private readonly jobs: JobQueue,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly newId: () => string,
    private readonly logger: Logger,
    private readonly options: GitRepositoryServiceOptions,
  ) {}

  /** Tests access without saving anything. Validation problems throw; remote failures are returned. */
  async testConnection(
    workspaceId: string,
    input: { gitProviderType: string; remoteUrl: string; auth: RepositoryAuthInput },
    actorUserId: string,
  ): Promise<ConnectionTestResult> {
    const provider = this.providers.get(input.gitProviderType);
    const remoteUrl = normalizeRemoteUrl(input.remoteUrl);
    await this.#assertHost(remoteUrl);
    const result = await this.#probe(workspaceId, provider, remoteUrl, input.auth);
    await this.audit.record({
      action: 'repository.test',
      outcome: result.ok ? 'success' : 'failure',
      actorUserId,
      workspaceId,
      meta: {
        remoteUrl,
        gitProviderType: provider.descriptor.type,
        reason: result.ok ? undefined : result.reason,
      },
      knownSecrets: input.auth.type === 'token' ? [input.auth.token] : [],
    });
    return result;
  }

  /** Re-tests a saved connection and records the result on its credential. */
  async testSaved(workspaceId: string, id: string, actorUserId: string): Promise<ConnectionTestResult> {
    const conn = await this.#find(workspaceId, id);
    const auth: RepositoryAuthInput = conn.credentialId
      ? { type: 'credential', credentialId: conn.credentialId }
      : { type: 'none' };
    return this.testConnection(
      workspaceId,
      { gitProviderType: conn.gitProviderType, remoteUrl: conn.remoteUrl, auth },
      actorUserId,
    );
  }

  async create(
    workspaceId: string,
    input: {
      name?: string;
      gitProviderType: string;
      remoteUrl: string;
      defaultBranch?: string;
      auth: RepositoryAuthInput;
    },
    actorUserId: string,
  ): Promise<RepositoryView> {
    const provider = this.providers.get(input.gitProviderType);
    const remoteUrl = normalizeRemoteUrl(input.remoteUrl);
    const name = validateRepositoryName(input.name?.trim() || repositoryNameFromUrl(remoteUrl));
    let defaultBranch = input.defaultBranch?.trim() ? validateBranchName(input.defaultBranch) : null;
    if (await this.repo.findByRemote(workspaceId, remoteUrl)) {
      throw new ConflictError('This repository is already connected to the workspace.', 'repository_exists');
    }
    await this.#assertHost(remoteUrl);

    const probe = await this.#probe(workspaceId, provider, remoteUrl, input.auth);
    if (!probe.ok) throw new ValidationError(probe.message, { remoteUrl: probe.message });
    defaultBranch ??=
      probe.defaultBranch ?? (probe.branches.includes('main') ? 'main' : (probe.branches[0] ?? null));
    if (!defaultBranch)
      throw new ValidationError('The repository has no branches yet.', {
        defaultBranch: 'Push an initial commit first.',
      });
    if (!probe.branches.includes(defaultBranch)) {
      throw new ValidationError('Branch not found on the remote.', {
        defaultBranch: `No branch named "${defaultBranch}".`,
      });
    }

    let credentialId: string | null = null;
    let createdCredentialId: string | null = null;
    if (input.auth.type === 'credential') {
      credentialId = (await this.credentials.get(workspaceId, input.auth.credentialId)).id;
    } else if (input.auth.type === 'token') {
      const cred = await this.credentials.create(
        {
          workspaceId,
          kind: 'git',
          providerType: provider.descriptor.type,
          label: input.auth.label?.trim() || `${name} token`,
          secret: input.auth.token,
          meta: input.auth.username?.trim() ? { username: input.auth.username.trim() } : {},
        },
        actorUserId,
      );
      credentialId = createdCredentialId = cred.id;
      await this.credentials.recordTestResult(cred.id, 'ok', null);
    }

    const id = this.newId();
    const now = this.clock.now();
    const conn: GitRepositoryConnection = {
      id,
      workspaceId,
      name,
      gitProviderType: provider.descriptor.type,
      remoteUrl,
      defaultBranch,
      credentialId,
      webhookCredentialId: null,
      localClonePath: path.posix.join('repos', id),
      syncStatus: 'pending',
      lastSyncError: null,
      headSha: null,
      lastFetchedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await this.repo.insert(conn);
    } catch (error) {
      if (createdCredentialId)
        await this.credentials.delete(workspaceId, createdCredentialId, actorUserId).catch(() => {});
      throw error;
    }
    await this.audit.record({
      action: 'repository.create',
      actorUserId,
      workspaceId,
      entityType: 'repository',
      entityId: id,
      meta: {
        name,
        remoteUrl,
        gitProviderType: conn.gitProviderType,
        defaultBranch,
        authenticated: credentialId !== null,
      },
      knownSecrets: input.auth.type === 'token' ? [input.auth.token] : [],
    });
    await this.#enqueueSync(id, actorUserId);
    return this.get(workspaceId, id);
  }

  async list(workspaceId: string): Promise<RepositoryView[]> {
    const conns = await this.repo.list(workspaceId);
    return Promise.all(conns.map((c) => this.#view(c)));
  }

  async get(workspaceId: string, id: string): Promise<RepositoryView> {
    return this.#view(await this.#find(workspaceId, id));
  }

  async update(
    workspaceId: string,
    id: string,
    input: { name?: string; defaultBranch?: string },
    actorUserId: string,
  ): Promise<RepositoryView> {
    await this.#find(workspaceId, id);
    const name = input.name === undefined ? undefined : validateRepositoryName(input.name);
    const defaultBranch =
      input.defaultBranch === undefined ? undefined : validateBranchName(input.defaultBranch);
    await this.repo.update(id, { name, defaultBranch, updatedAt: this.clock.now() });
    await this.audit.record({
      action: 'repository.update',
      actorUserId,
      workspaceId,
      entityType: 'repository',
      entityId: id,
      meta: { name, defaultBranch },
    });
    if (defaultBranch !== undefined) await this.#enqueueSync(id, actorUserId);
    return this.get(workspaceId, id);
  }

  /** Branch names from the local clone (remote-tracking refs). Empty until the first sync completes. */
  async branches(workspaceId: string, id: string): Promise<string[]> {
    const conn = await this.#find(workspaceId, id);
    const dir = this.#cloneDir(conn);
    try {
      await fs.access(path.join(dir, '.git'));
    } catch {
      return [];
    }
    return this.providers.get(conn.gitProviderType).listBranches(dir);
  }

  async requestSync(workspaceId: string, id: string, actorUserId: string): Promise<RepositoryView> {
    await this.#find(workspaceId, id);
    await this.#enqueueSync(id, actorUserId);
    await this.audit.record({
      action: 'repository.sync_requested',
      actorUserId,
      workspaceId,
      entityType: 'repository',
      entityId: id,
    });
    return this.get(workspaceId, id);
  }

  async delete(workspaceId: string, id: string, actorUserId: string): Promise<void> {
    const conn = await this.#find(workspaceId, id);
    await this.repo.delete(id);
    await fs.rm(this.#cloneDir(conn), { recursive: true, force: true });
    await this.audit.record({
      action: 'repository.delete',
      actorUserId,
      workspaceId,
      entityType: 'repository',
      entityId: id,
      meta: { name: conn.name, remoteUrl: conn.remoteUrl },
    });
  }

  /** Job handler body: clone or fetch the connection's remote into the data directory. */
  async sync(connectionId: string, signal?: AbortSignal): Promise<void> {
    const conn = await this.repo.findByIdUnscoped(connectionId);
    if (!conn) throw new PermanentJobError('Repository connection no longer exists.');
    const provider = this.providers.get(conn.gitProviderType);
    await this.repo.update(conn.id, { syncStatus: 'syncing', updatedAt: this.clock.now() });
    try {
      await this.#assertHost(conn.remoteUrl);
      const targetDir = this.#cloneDir(conn);
      const run = (auth: GitHttpAuth | null) =>
        provider.syncClone({
          remoteUrl: conn.remoteUrl,
          branch: conn.defaultBranch,
          targetDir,
          auth,
          signal,
        });
      const result = conn.credentialId
        ? await this.credentials.withPlaintext(conn.workspaceId, conn.credentialId, (token, cred) =>
            run({ username: cred.meta.username || provider.defaultUsername(), token }),
          )
        : await run(null);
      const now = this.clock.now();
      await this.repo.update(conn.id, {
        syncStatus: 'ready',
        lastSyncError: null,
        headSha: result.headSha,
        lastFetchedAt: now,
        updatedAt: now,
      });
      await this.audit.record({
        action: 'repository.sync',
        workspaceId: conn.workspaceId,
        entityType: 'repository',
        entityId: conn.id,
        meta: { cloned: result.cloned, headSha: result.headSha },
      });
    } catch (error) {
      const message =
        error instanceof GitOperationError ||
        error instanceof DecryptionError ||
        error instanceof ValidationError
          ? error.message
          : safeErrorMessage(error);
      await this.repo.update(conn.id, {
        syncStatus: 'error',
        lastSyncError: message,
        updatedAt: this.clock.now(),
      });
      this.logger.warn('repository sync failed', { repositoryId: conn.id, error: message });
      const permanent =
        error instanceof DecryptionError ||
        error instanceof ValidationError ||
        (error instanceof GitOperationError && ['auth', 'not_found', 'invalid'].includes(error.kind));
      if (permanent) throw new PermanentJobError(message);
      throw error;
    }
  }

  async #probe(
    workspaceId: string,
    provider: GitProvider,
    remoteUrl: string,
    auth: RepositoryAuthInput,
  ): Promise<ConnectionTestResult> {
    const run = async (httpAuth: GitHttpAuth | null): Promise<ConnectionTestResult> => {
      try {
        const probe: RemoteProbe = await provider.testConnection(remoteUrl, httpAuth);
        return {
          ok: true,
          defaultBranch: probe.defaultBranch,
          branches: probe.branches.slice(0, 200),
          branchCount: probe.branches.length,
        };
      } catch (error) {
        if (error instanceof GitOperationError)
          return { ok: false, reason: error.kind, message: error.message };
        throw error;
      }
    };

    if (auth.type === 'none') return run(null);
    if (auth.type === 'token') {
      const token = auth.token?.trim();
      if (!token) throw new ValidationError('A token is required.', { token: 'Required.' });
      return run({ username: auth.username?.trim() || provider.defaultUsername(), token });
    }
    try {
      const result = await this.credentials.withPlaintext(workspaceId, auth.credentialId, (token, cred) =>
        run({ username: cred.meta.username || provider.defaultUsername(), token }),
      );
      await this.credentials.recordTestResult(
        auth.credentialId,
        result.ok ? 'ok' : 'failed',
        result.ok ? null : result.message,
      );
      return result;
    } catch (error) {
      if (error instanceof DecryptionError)
        return { ok: false, reason: 'credential', message: error.message };
      throw error;
    }
  }

  async #assertHost(remoteUrl: string): Promise<void> {
    await assertAllowedHost(new URL(remoteUrl).hostname, {
      allowPrivateNetworks: this.options.allowPrivateNetworks,
      resolver: this.options.resolver,
    });
  }

  async #enqueueSync(id: string, requestedBy: string | null): Promise<void> {
    await this.jobs.enqueue(
      REPOSITORY_SYNC_JOB,
      { repositoryId: id, requestedBy },
      { dedupeKey: `${REPOSITORY_SYNC_JOB}:${id}` },
    );
  }

  /** Clone directory, guaranteed to be inside `<dataDir>/repos` (symlinks included). */
  #cloneDir(conn: GitRepositoryConnection): string {
    const dir = resolveWithin(this.options.dataDir, conn.localClonePath);
    const reposRoot = path.resolve(this.options.reposDir);
    if (path.dirname(dir) !== reposRoot)
      throw new PermanentJobError('Clone path is outside the repositories directory.');
    return resolveRealWithin(this.options.dataDir, conn.localClonePath);
  }

  async #find(workspaceId: string, id: string): Promise<GitRepositoryConnection> {
    const conn = await this.repo.findById(workspaceId, id);
    if (!conn) throw new NotFoundError('Repository not found.');
    return conn;
  }

  async #view(conn: GitRepositoryConnection): Promise<RepositoryView> {
    const provider = this.providers.has(conn.gitProviderType)
      ? this.providers.get(conn.gitProviderType)
      : null;
    const credential = conn.credentialId
      ? await this.credentials.get(conn.workspaceId, conn.credentialId).catch(() => null)
      : null;
    const job = await this.jobs.latestFor(`${REPOSITORY_SYNC_JOB}:${conn.id}`);
    return {
      id: conn.id,
      workspaceId: conn.workspaceId,
      name: conn.name,
      gitProviderType: conn.gitProviderType,
      providerName: provider?.descriptor.displayName ?? conn.gitProviderType,
      remoteUrl: conn.remoteUrl,
      defaultBranch: conn.defaultBranch,
      credential,
      syncStatus: conn.syncStatus,
      lastSyncError: conn.lastSyncError,
      headSha: conn.headSha,
      lastFetchedAt: conn.lastFetchedAt?.toISOString() ?? null,
      createdAt: conn.createdAt.toISOString(),
      sync: job ? { status: job.status, attempts: job.attempts, runAfter: job.runAfter.toISOString() } : null,
    };
  }
}
