import { z } from 'zod';
import type { Clock } from '@/server/domain/clock';
import {
  deploymentAttemptView,
  type DeploymentBinding,
  type DeploymentAttempt,
  type DeploymentProviderType,
} from '@/server/domain/deployment';
import { ConflictError, NotFoundError, ValidationError } from '@/server/domain/errors';
import type { Job } from '@/server/domain/job';
import type { JobContext } from '@/server/jobs/worker';
import type { DeploymentProvider } from '@/server/providers/deployment/types';
import type { AuditService } from './audit-service';
import type { CredentialService } from './credential-service';
import type { JobQueue } from './job-queue';
import type { Repositories } from './ports';

export const DEPLOYMENT_TRIGGER_JOB = 'deployment_trigger';
const inputSchema = z
  .object({
    providerType: z.enum(['portainer-webhook', 'generic-webhook']),
    enabled: z.boolean(),
    deployOnPush: z.literal(false).optional(),
    expectedRevision: z.string().min(1).nullable(),
    configuration: z.object({ url: z.string(), bearerToken: z.string().optional() }).strict().optional(),
    credentialId: z.string().min(1).optional(),
  })
  .strict()
  .refine((v) => !(v.configuration && v.credentialId), 'Choose configuration or credential.');
export type ConfigureDeploymentInput = z.infer<typeof inputSchema>;

type TriggerOutcome = {
  status: 'accepted' | 'rejected' | 'unknown';
  httpStatus: number | null;
  reason: string | null;
};

export class DeploymentService {
  constructor(
    private readonly repos: Repositories,
    private readonly credentials: CredentialService,
    private readonly providers: Map<DeploymentProviderType, DeploymentProvider>,
    private readonly jobs: JobQueue,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly newId: () => string,
  ) {}
  private async stack(workspaceId: string, stackId: string) {
    const stack = await this.repos.stacks.findById(workspaceId, stackId);
    if (!stack) throw new NotFoundError('Stack not found.');
    return stack;
  }
  async settings(workspaceId: string, stackId: string) {
    await this.stack(workspaceId, stackId);
    const b = await this.repos.deployments.binding(workspaceId, stackId);
    const credential = b && (await this.repos.credentials.findById(workspaceId, b.credentialId));
    return {
      binding: b
        ? {
            ...b,
            deployOnPush: false as const,
            hint: '••••',
            lastTestedAt: credential?.lastTestedAt?.toISOString() ?? null,
            lastTestStatus: credential?.lastTestStatus ?? null,
            lastTestMessage: credential?.lastTestMessage ?? null,
            createdAt: b.createdAt.toISOString(),
            updatedAt: b.updatedAt.toISOString(),
            lastAttemptAt: b.lastAttemptAt?.toISOString() ?? null,
            lastAcceptedAt: b.lastAcceptedAt?.toISOString() ?? null,
            lastFailedAt: b.lastFailedAt?.toISOString() ?? null,
          }
        : null,
    };
  }

  async test(workspaceId: string, stackId: string, actorUserId: string) {
    await this.stack(workspaceId, stackId);
    const binding = await this.repos.deployments.binding(workspaceId, stackId);
    if (!binding) throw new NotFoundError('Deployment binding not found.');
    const credential = await this.repos.credentials.findById(workspaceId, binding.credentialId);
    if (!credential) throw new ConflictError('Deployment credential unavailable.');
    let status: 'ok' | 'failed' = 'ok';
    try {
      await this.credentials.withPlaintext(
        workspaceId,
        binding.credentialId,
        async (secret) => {
          const provider = this.providers.get(binding.providerType)!;
          await provider.validateDestination(provider.validateConfiguration(JSON.parse(secret)));
        },
        { kind: 'deployment', providerType: binding.providerType, nonce: credential.secretNonce },
      );
    } catch {
      status = 'failed';
    }
    const message =
      status === 'ok'
        ? 'Destination DNS and network policy validated. No webhook sent; TLS and HTTP response were not tested.'
        : 'Destination validation failed. No webhook sent; TLS and HTTP response were not tested.';
    await this.repos.deployments.recordValidation(
      workspaceId,
      stackId,
      { revision: binding.revision, credentialId: binding.credentialId, nonce: credential.secretNonce },
      { at: this.clock.now(), status, message },
    );
    await this.audit.record({
      action: 'deployment.binding_updated',
      actorUserId,
      workspaceId,
      entityType: 'stack',
      entityId: stackId,
      meta: { destinationValidation: status },
    });
    return this.settings(workspaceId, stackId);
  }
  async configure(
    workspaceId: string,
    stackId: string,
    input: ConfigureDeploymentInput,
    actorUserId: string,
  ) {
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) throw new ValidationError('Invalid deployment settings.');
    input = parsed.data;
    await this.stack(workspaceId, stackId);
    const existing = await this.repos.deployments.binding(workspaceId, stackId);
    if ((existing?.revision ?? null) !== input.expectedRevision)
      throw new ConflictError('Deployment settings changed. Reload and try again.');
    const provider = this.providers.get(input.providerType)!;
    let record;
    if (input.configuration) {
      const config = provider.validateConfiguration(input.configuration);
      await provider.validateDestination(config);
      record = await this.credentials.prepare(
        {
          workspaceId,
          kind: 'deployment',
          providerType: input.providerType,
          label: 'Stack deployment webhook',
          secret: JSON.stringify(config),
        },
        actorUserId,
      );
    }
    const credentialId = record?.id ?? input.credentialId ?? existing?.credentialId;
    if (!credentialId) throw new ValidationError('A deployment webhook configuration is required.');
    if (!record)
      await this.credentials.withPlaintext(
        workspaceId,
        credentialId,
        async (secret) => {
          let value: unknown;
          try {
            value = JSON.parse(secret);
          } catch {
            throw new ValidationError('Invalid deployment credential.');
          }
          const config = provider.validateConfiguration(value);
          if (credentialId !== existing?.credentialId || input.providerType !== existing?.providerType)
            await provider.validateDestination(config);
        },
        { kind: 'deployment', providerType: input.providerType },
      );
    const now = this.clock.now();
    let managedCredential = existing?.managedCredential ?? false;
    if (record) managedCredential = true;
    else if (input.credentialId) managedCredential = false;
    const binding: DeploymentBinding = {
      id: existing?.id ?? this.newId(),
      workspaceId,
      stackId,
      providerType: input.providerType,
      credentialId,
      managedCredential,
      enabled: input.enabled,
      deployOnPush: false,
      revision: this.newId(),
      lastAttemptAt: existing?.lastAttemptAt ?? null,
      lastAcceptedAt: existing?.lastAcceptedAt ?? null,
      lastFailedAt: existing?.lastFailedAt ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await this.repos.deployments.save(binding, input.expectedRevision, record);
    const updateAction = binding.enabled ? 'deployment.binding_updated' : 'deployment.binding_disabled';
    await this.audit.record({
      action: existing ? updateAction : 'deployment.binding_created',
      actorUserId,
      workspaceId,
      entityType: 'stack',
      entityId: stackId,
    });
    if (record && existing)
      await this.audit.record({
        action: 'deployment.secret_rotated',
        actorUserId,
        workspaceId,
        entityType: 'stack',
        entityId: stackId,
      });
    return this.settings(workspaceId, stackId);
  }
  async remove(workspaceId: string, stackId: string, actorUserId: string, expectedRevision?: string) {
    await this.stack(workspaceId, stackId);
    const b = await this.repos.deployments.binding(workspaceId, stackId);
    if (!b) throw new NotFoundError('Deployment binding not found.');
    await this.repos.deployments.remove(workspaceId, stackId, expectedRevision ?? b.revision);
    await this.audit.record({
      action: 'deployment.binding_removed',
      actorUserId,
      workspaceId,
      entityType: 'stack',
      entityId: stackId,
    });
  }
  private async recover(stackId: string) {
    // Keep recovery audit writes ordered and avoid concurrent writes on the single SQLite connection.
    for (const a of await this.repos.deployments.recover(stackId, this.clock.now())) {
      await this.audit.record({
        action: 'deployment.unknown',
        actorUserId: a.actorUserId,
        workspaceId: a.workspaceId,
        entityType: 'deployment_attempt',
        entityId: a.id,
        meta: { reason: 'worker_interrupted' },
      });
    }
  }
  async trigger(workspaceId: string, stackId: string, actorUserId: string) {
    await this.stack(workspaceId, stackId);
    await this.recover(stackId);
    const b = await this.repos.deployments.binding(workspaceId, stackId);
    if (!b?.enabled) throw new ConflictError('An enabled deployment binding is required.');
    const actor = await this.repos.users.findById(actorUserId);
    if (!actor || actor.disabledAt) throw new ConflictError('Operator is no longer active.');
    const c = await this.repos.credentials.findById(workspaceId, b.credentialId);
    if (c?.kind !== 'deployment' || c.providerType !== b.providerType)
      throw new ConflictError('Deployment credential unavailable.');
    await this.credentials.withPlaintext(
      workspaceId,
      b.credentialId,
      (secret) => {
        let value: unknown;
        try {
          value = JSON.parse(secret);
        } catch {
          throw new ValidationError('Invalid deployment configuration.');
        }
        this.providers.get(b.providerType)!.validateConfiguration(value);
      },
      { kind: 'deployment', providerType: b.providerType, nonce: c.secretNonce },
    );
    const id = this.newId();
    const job = this.jobs.prepare(
      DEPLOYMENT_TRIGGER_JOB,
      { attemptId: id },
      { dedupeKey: `deployment:${stackId}`, maxAttempts: 3 },
    );
    const attempt = {
      id,
      workspaceId,
      stackId,
      bindingId: b.id,
      providerType: b.providerType,
      actorUserId,
      triggerType: 'manual' as const,
      requestedAt: this.clock.now(),
      status: 'queued' as const,
      httpStatus: null,
      reason: null,
      completedAt: null,
      bindingRevision: b.revision,
      credentialNonce: c.secretNonce,
      jobId: job.id,
    };
    await this.repos.deployments.enqueue(attempt, job);
    await this.audit.record({
      action: 'deployment.requested',
      actorUserId,
      workspaceId,
      entityType: 'deployment_attempt',
      entityId: id,
    });
    return { attempt: deploymentAttemptView(attempt) };
  }
  async history(workspaceId: string, stackId: string) {
    await this.stack(workspaceId, stackId);
    await this.recover(stackId);
    return {
      attempts: (await this.repos.deployments.history(workspaceId, stackId)).map(deploymentAttemptView),
    };
  }
  async execute(job: Job, ctx: JobContext) {
    const id = job.payload.attemptId;
    if (typeof id !== 'string' || !job.leaseOwner) return;
    const a = await this.repos.deployments.findAttempt(id);
    if (!a) return;
    if (a.status !== 'queued' && a.status !== 'running') return;
    let result: TriggerOutcome;
    if (a.status === 'running')
      result = {
        status: 'unknown',
        httpStatus: null,
        reason: 'Worker interrupted after request intent; verify destination before retrying.',
      };
    else {
      if (!(await this.repos.deployments.begin(id, job.leaseOwner, this.clock.now()))) {
        const stopped = await this.repos.deployments.findAttempt(id);
        if (stopped?.status === 'rejected')
          await this.audit.record({
            action: 'deployment.rejected',
            actorUserId: a.actorUserId,
            workspaceId: a.workspaceId,
            entityType: 'deployment_attempt',
            entityId: id,
          });
        return;
      }
      result = await this.send(a, ctx);
    }
    if (await this.repos.deployments.finish(id, job.leaseOwner, result, this.clock.now())) {
      if (result.status === 'accepted') await ctx.recordAcceptance();
      await this.audit.record({
        action: `deployment.${result.status}`,
        actorUserId: a.actorUserId,
        workspaceId: a.workspaceId,
        entityType: 'deployment_attempt',
        entityId: id,
        meta: { httpStatus: result.httpStatus },
      });
    }
  }
  private async send(a: DeploymentAttempt, ctx: JobContext): Promise<TriggerOutcome> {
    try {
      const b = await this.repos.deployments.binding(a.workspaceId, a.stackId);
      const c = b && (await this.repos.credentials.findById(a.workspaceId, b.credentialId));
      if (!b?.enabled || b.revision !== a.bindingRevision || c?.secretNonce !== a.credentialNonce)
        return {
          status: 'rejected',
          httpStatus: null,
          reason: 'Deployment settings changed before send.',
        };
      return await this.credentials.withPlaintext(
        a.workspaceId,
        b.credentialId,
        async (secret) => {
          const provider = this.providers.get(b.providerType)!;
          const config = provider.validateConfiguration(JSON.parse(secret));
          ctx.signal.throwIfAborted();
          const r = await provider.trigger(config, { signal: ctx.signal, idempotencyKey: a.id });
          return {
            status: r.status,
            httpStatus: 'httpStatus' in r ? r.httpStatus : null,
            reason:
              r.status === 'unknown'
                ? 'Request outcome uncertain; verify destination before retrying.'
                : null,
          };
        },
        { kind: 'deployment', providerType: b.providerType, nonce: a.credentialNonce },
      );
    } catch {
      return {
        status: 'unknown',
        httpStatus: null,
        reason: 'Request outcome uncertain; verify destination before retrying.',
      };
    }
  }
}
