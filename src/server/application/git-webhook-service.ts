import { createHash } from 'node:crypto';
import type { Clock } from '@/server/domain/clock';
import {
  AuthenticationError,
  NotFoundError,
  RateLimitedError,
  ValidationError,
} from '@/server/domain/errors';
import { normalizeRemoteUrl } from '@/server/domain/git-repository';
import { AttemptLimiter } from '@/server/security/rate-limit';
import { gitWebhookAdapter } from '@/server/providers/git/webhooks';
import type { AuditService } from './audit-service';
import type { CredentialService } from './credential-service';
import { REPOSITORY_SYNC_JOB } from './git-repository-service';
import type { JobQueue } from './job-queue';
import type {
  CredentialRepository,
  GitRepositoryConnectionRepository,
  GitWebhookDeliveryRepository,
} from './ports';

export class GitWebhookService {
  private readonly requestLimiter = new AttemptLimiter(120, 60_000);

  limitRequests(ip: string | null) {
    // A shared webhook quota bounds unattributed traffic even when URL IDs are attacker-controlled.
    const key = ip ? `ip:${ip}` : 'unattributed-webhooks';
    if (this.requestLimiter.isBlocked(key)) throw new RateLimitedError();
    this.requestLimiter.recordFailure(key);
  }

  constructor(
    private readonly repositories: GitRepositoryConnectionRepository,
    private readonly credentials: CredentialService,
    private readonly credentialRecords: CredentialRepository,
    private readonly deliveries: GitWebhookDeliveryRepository,
    private readonly jobs: JobQueue,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly newId: () => string,
  ) {}

  async settings(workspaceId: string, repositoryId: string) {
    const conn = await this.#connection(workspaceId, repositoryId);
    return {
      configured: conn.webhookCredentialId !== null,
      hint: conn.webhookCredentialId ? '••••' : null,
      lastAcceptedAt: (await this.deliveries.latestAccepted(repositoryId))?.receivedAt.toISOString() ?? null,
    };
  }

  async configure(
    workspaceId: string,
    repositoryId: string,
    input: { secret?: string; credentialId?: string },
    actor: string,
  ) {
    const conn = await this.#connection(workspaceId, repositoryId);
    let id: string;
    if (input.credentialId) {
      const credential = await this.credentials.get(workspaceId, input.credentialId);
      this.#checkCredential(credential, conn.gitProviderType);
      id = credential.id;
    } else if (input.secret) {
      // Replace the linked record in place: no grace period and no orphan on rotation.
      if (conn.webhookCredentialId) {
        this.#checkCredential(
          await this.credentials.get(workspaceId, conn.webhookCredentialId),
          conn.gitProviderType,
        );
        id = (
          await this.credentials.replaceSecret(workspaceId, conn.webhookCredentialId, input.secret, actor)
        ).id;
      } else {
        id = (
          await this.credentials.create(
            {
              workspaceId,
              kind: 'git_webhook',
              providerType: conn.gitProviderType,
              label: 'Git webhook signing',
              secret: input.secret,
            },
            actor,
          )
        ).id;
      }
    } else {
      throw new ValidationError('Choose a signing credential or supply a signing secret.');
    }
    await this.repositories.update(repositoryId, { webhookCredentialId: id, updatedAt: this.clock.now() });
    await this.audit.record({
      action: 'repository.update',
      actorUserId: actor,
      workspaceId,
      entityType: 'repository',
      entityId: repositoryId,
      meta: { webhookConfigured: true },
    });
    return this.settings(workspaceId, repositoryId);
  }

  async disable(workspaceId: string, repositoryId: string, actor: string) {
    await this.#connection(workspaceId, repositoryId);
    await this.repositories.update(repositoryId, { webhookCredentialId: null, updatedAt: this.clock.now() });
    await this.audit.record({
      action: 'repository.update',
      actorUserId: actor,
      workspaceId,
      entityType: 'repository',
      entityId: repositoryId,
      meta: { webhookConfigured: false },
    });
    return this.settings(workspaceId, repositoryId);
  }

  async receive(workspaceId: string, repositoryId: string, headers: Headers, bytes: Uint8Array) {
    const conn = await this.repositories.findById(workspaceId, repositoryId);
    if (!conn?.webhookCredentialId) throw new AuthenticationError('Webhook authentication failed.');
    const record = await this.credentialRecords.findById(workspaceId, conn.webhookCredentialId);
    if (record?.kind !== 'git_webhook' || record.providerType !== conn.gitProviderType) {
      throw new AuthenticationError('Webhook authentication failed.');
    }
    const event = await this.credentials.withPlaintext(workspaceId, record.id, (secret, credential) => {
      this.#checkCredential(credential, conn.gitProviderType);
      return gitWebhookAdapter(conn.gitProviderType).verify(headers, bytes, secret);
    });
    const push = event.push;
    const relevant =
      !!push &&
      !push.deleted &&
      push.ref === `refs/heads/${conn.defaultBranch}` &&
      this.#matchesRemote(push.cloneUrl, conn.remoteUrl);
    const delivery = {
      id: this.newId(),
      repositoryId,
      provider: conn.gitProviderType,
      deliveryId: event.deliveryId,
      eventType: event.eventType,
      bodyHash: relevant ? createHash('sha256').update(bytes).digest('hex') : null,
      ref: push?.ref ?? null,
      receivedAt: this.clock.now(),
      status: relevant ? ('accepted' as const) : ('ignored' as const),
      jobId: null,
    };
    const result = await this.deliveries.accept(
      delivery,
      relevant
        ? this.jobs.prepare(
            REPOSITORY_SYNC_JOB,
            { repositoryId },
            {
              dedupeKey: `${REPOSITORY_SYNC_JOB}:${repositoryId}`,
              followUpIfRunning: true,
            },
          )
        : null,
      {
        credentialId: record.id,
        nonce: record.secretNonce,
        branch: conn.defaultBranch,
        remoteUrl: conn.remoteUrl,
      },
    );
    if (result.duplicate) return 'duplicate';
    return relevant ? 'accepted' : 'ignored';
  }

  #matchesRemote(supplied: string, stored: string) {
    try {
      return (
        normalizeRemoteUrl(supplied).replace(/\.git$/, '') ===
        normalizeRemoteUrl(stored).replace(/\.git$/, '')
      );
    } catch {
      return false;
    }
  }

  #checkCredential(credential: { kind: string; providerType: string }, provider: string) {
    if (credential.kind !== 'git_webhook' || credential.providerType !== provider)
      throw new ValidationError('Choose a matching Git webhook signing credential.');
  }

  async #connection(workspaceId: string, id: string) {
    const conn = await this.repositories.findById(workspaceId, id);
    if (!conn) throw new NotFoundError('Repository not found.');
    return conn;
  }
}
