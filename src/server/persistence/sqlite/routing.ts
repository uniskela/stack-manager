import { and, asc, desc, eq, isNotNull, isNull, inArray } from 'drizzle-orm';
import type {
  DeploymentRoutingRepository,
  RoutingRecord,
  RoutingSource,
} from '@/server/application/deployment-routing-ports';
import { ConflictError } from '@/server/domain/errors';
import {
  deploymentAttempts,
  deploymentBindings,
  deploymentRoutingDecisions,
  gitRepositoryConnections,
  gitWebhookDeliveries,
  jobs,
  providerCredentials,
  stacks,
} from '../schema';
import type { SqliteDb } from './database';
import { SqliteDeploymentRepository } from './repositories';

/** Rechecked at the final send boundary, including rotations made after routing. */
export function automaticSourceValid(db: Pick<SqliteDb, 'select'>, attemptId: string): boolean {
  const d = db
    .select()
    .from(deploymentRoutingDecisions)
    .where(eq(deploymentRoutingDecisions.attemptId, attemptId))
    .get();
  if (!d) return false;
  const source = db
    .select()
    .from(gitWebhookDeliveries)
    .where(eq(gitWebhookDeliveries.id, d.sourceDeliveryId))
    .get();
  const conn = db
    .select()
    .from(gitRepositoryConnections)
    .where(eq(gitRepositoryConnections.id, d.repositoryId))
    .get();
  const signing =
    source?.signingCredentialId &&
    db.select().from(providerCredentials).where(eq(providerCredentials.id, source.signingCredentialId)).get();
  return Boolean(
    source &&
    conn &&
    signing &&
    conn.webhookCredentialId === source.signingCredentialId &&
    signing.secretNonce === source.signingNonce &&
    source.ref === `refs/heads/${conn.defaultBranch}`,
  );
}

export class SqliteDeploymentRoutingRepository implements DeploymentRoutingRepository {
  constructor(private readonly db: SqliteDb) {}
  async hasPending(repositoryId: string) {
    return Boolean(
      this.db
        .select({ id: gitWebhookDeliveries.id })
        .from(gitWebhookDeliveries)
        .where(
          and(
            eq(gitWebhookDeliveries.repositoryId, repositoryId),
            isNull(gitWebhookDeliveries.processedAt),
            isNotNull(gitWebhookDeliveries.afterSha),
          ),
        )
        .get(),
    );
  }
  async sourceValid(attemptId: string) {
    return automaticSourceValid(this.db, attemptId);
  }
  async pending(repositoryId: string) {
    return this.db
      .select({
        id: gitWebhookDeliveries.id,
        repositoryId: gitWebhookDeliveries.repositoryId,
        afterSha: gitWebhookDeliveries.afterSha,
        activeStackIds: gitWebhookDeliveries.activeStackIds,
        ref: gitWebhookDeliveries.ref,
        signingCredentialId: gitWebhookDeliveries.signingCredentialId,
        signingNonce: gitWebhookDeliveries.signingNonce,
        receivedAt: gitWebhookDeliveries.receivedAt,
      })
      .from(gitWebhookDeliveries)
      .innerJoin(jobs, eq(jobs.id, gitWebhookDeliveries.jobId))
      .where(
        and(
          eq(gitWebhookDeliveries.repositoryId, repositoryId),
          eq(gitWebhookDeliveries.status, 'accepted'),
          isNull(gitWebhookDeliveries.processedAt),
          isNotNull(gitWebhookDeliveries.afterSha),
          eq(jobs.status, 'succeeded'),
        ),
      )
      .orderBy(asc(gitWebhookDeliveries.receivedAt), asc(gitWebhookDeliveries.id))
      .limit(20)
      .all() as RoutingSource[];
  }
  async record(
    source: RoutingSource,
    records: RoutingRecord[],
    lease: { id: string; owner: string },
    now: Date,
  ) {
    return this.db.transaction(
      (tx) => {
        const j = tx.select().from(jobs).where(eq(jobs.id, lease.id)).get();
        if (
          j?.status !== 'running' ||
          j.leaseOwner !== lease.owner ||
          !j.leaseExpiresAt ||
          j.leaseExpiresAt <= now
        )
          throw new ConflictError('Routing lease expired.');
        const delivery = tx
          .select()
          .from(gitWebhookDeliveries)
          .where(eq(gitWebhookDeliveries.id, source.id))
          .get();
        if (!delivery || delivery.processedAt) return [];
        const conn = tx
          .select()
          .from(gitRepositoryConnections)
          .where(eq(gitRepositoryConnections.id, source.repositoryId))
          .get();
        const signing =
          source.signingCredentialId &&
          tx
            .select()
            .from(providerCredentials)
            .where(eq(providerCredentials.id, source.signingCredentialId))
            .get();
        const results = [];
        for (const r of records) {
          const b = tx
            .select()
            .from(deploymentBindings)
            .where(eq(deploymentBindings.stackId, r.decision.stackId))
            .get();
          if (
            (b?.revision ?? null) !== r.decision.bindingRevision ||
            (b?.routingHeadSha ?? null) !== r.expectedHead
          )
            throw new ConflictError('Routing settings or checkpoint changed.');
          // A deleted stack has no remaining routing or deployment work.
          if (!tx.select().from(stacks).where(eq(stacks.id, r.decision.stackId)).get()) continue;
          const d = { ...r.decision };
          if (r.attempt && r.job) {
            if (
              !b?.deployOnPush ||
              b.automationHold ||
              !signing ||
              conn?.webhookCredentialId !== source.signingCredentialId ||
              signing.secretNonce !== source.signingNonce ||
              source.ref !== `refs/heads/${conn.defaultBranch}`
            ) {
              d.decision = 'blocked';
              d.reasonCode = 'source_changed';
              d.explanation = 'Deployment blocked: signing configuration changed or automation is on hold.';
              d.attemptId = null;
            } else {
              const active = tx
                .select()
                .from(deploymentAttempts)
                .where(
                  and(
                    eq(deploymentAttempts.stackId, d.stackId),
                    inArray(deploymentAttempts.status, ['queued', 'running']),
                  ),
                )
                .get();
              const activeJob = tx
                .select({ id: jobs.id })
                .from(jobs)
                .where(
                  and(eq(jobs.dedupeKey, r.job.dedupeKey!), inArray(jobs.status, ['pending', 'running'])),
                )
                .get();
              if (active || activeJob || source.activeStackIds.includes(d.stackId)) {
                d.decision = 'blocked';
                d.reasonCode = 'deployment_active';
                d.explanation =
                  'A deployment is active. This later routing intent is saved; inspect its outcome, then use Deploy now deliberately.';
                d.attemptId = null;
              } else {
                // Enqueue only stages jobs; failure must also roll back this source's decisions and checkpoints.
                new SqliteDeploymentRepository(tx).enqueueSync(r.attempt, r.job);
              }
            }
          }
          tx.insert(deploymentRoutingDecisions).values(d).run();
          if (b && r.advanceHead)
            tx.update(deploymentBindings)
              .set({ routingHeadSha: source.afterSha })
              .where(eq(deploymentBindings.id, b.id))
              .run();
          results.push(d);
        }
        tx.update(gitWebhookDeliveries)
          .set({ processedAt: now })
          .where(eq(gitWebhookDeliveries.id, source.id))
          .run();
        return results;
      },
      { behavior: 'immediate' },
    );
  }
  async history(workspaceId: string, stackId: string) {
    return this.db
      .select({ decision: deploymentRoutingDecisions })
      .from(deploymentRoutingDecisions)
      .innerJoin(stacks, eq(stacks.id, deploymentRoutingDecisions.stackId))
      .where(and(eq(stacks.id, stackId), eq(stacks.workspaceId, workspaceId)))
      .orderBy(desc(deploymentRoutingDecisions.createdAt), desc(deploymentRoutingDecisions.id))
      .limit(20)
      .all()
      .map((r) => r.decision);
  }
}
