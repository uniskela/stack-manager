import { evaluateRouting } from '@/shared/deployment-routing';
import type { Clock } from '@/server/domain/clock';
import type { DeploymentAttempt, PersistedRoutingDecision } from '@/server/domain/deployment';
import type { Job } from '@/server/domain/job';
import type { JobContext } from '@/server/jobs/worker';
import type { HistoryReader } from '@/server/providers/git/types';
import type { AuditService } from './audit-service';
import { DEPLOYMENT_TRIGGER_JOB } from './deployment-service';
import type { RoutingRecord } from './deployment-routing-ports';
import type { GitRepositoryService } from './git-repository-service';
import type { JobQueue } from './job-queue';
import type { Repositories } from './ports';

export const DEPLOYMENT_ROUTE_JOB = 'deployment_route';

export class DeploymentRoutingService {
  constructor(
    private readonly repos: Repositories,
    private readonly repositories: GitRepositoryService,
    private readonly history: HistoryReader,
    private readonly jobs: JobQueue,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly newId: () => string,
  ) {}

  async execute(job: Job, ctx: JobContext) {
    const repositoryId = job.payload.repositoryId;
    if (typeof repositoryId !== 'string' || !job.leaseOwner) return;
    // Drain bounded pages. New pushes retain their own ledger rows even if jobs coalesce.
    for (let page = 0; page < 10; page++) {
      const sources = await this.repos.routing.pending(repositoryId);
      if (!sources.length) return;
      // Sources share checkpoints; propagate lookup failures for job retry instead of skipping ahead.
      for (const source of sources) {
        ctx.signal.throwIfAborted();
        const conn = await this.repos.gitRepositories.findByIdUnscoped(repositoryId);
        if (!conn) return;
        const stacks = await this.repos.stacks.listByRepository(conn.workspaceId, repositoryId);
        if (stacks.length > 1000) throw new Error('Routing stack limit exceeded.');
        const local = await this.repositories.localSource(conn.workspaceId, repositoryId);
        const signing =
          source.signingCredentialId &&
          (await this.repos.credentials.findById(conn.workspaceId, source.signingCredentialId));
        const trusted =
          signing &&
          signing.secretNonce === source.signingNonce &&
          source.signingCredentialId === conn.webhookCredentialId &&
          source.ref === `refs/heads/${conn.defaultBranch}`;
        const records: RoutingRecord[] = [];
        const diffCache = new Map<string, Promise<string[]>>();
        let evaluationWork = 0;
        for (const stack of stacks) {
          const recovered = await this.repos.deployments.recover(stack.id, this.clock.now());
          for (const a of recovered)
            await this.audit.record({
              action: 'deployment.unknown',
              outcome: 'failure',
              workspaceId: conn.workspaceId,
              entityType: 'deployment_attempt',
              entityId: a.id,
              meta: { reason: 'worker_interrupted' },
            });
          const b = await this.repos.deployments.binding(conn.workspaceId, stack.id);
          const now = this.clock.now();
          const d: PersistedRoutingDecision = {
            id: this.newId(),
            repositoryId,
            sourceDeliveryId: source.id,
            stackId: stack.id,
            bindingRevision: b?.revision ?? null,
            beforeSha: b?.routingHeadSha ?? null,
            afterSha: source.afterSha,
            matchedPaths: [],
            decision: 'skip',
            reasonCode: 'deploy_on_push_disabled',
            explanation: `${stack.name} skipped: automatic deployment disabled.`,
            attemptId: null,
            createdAt: now,
            processedAt: now,
          };
          const r: RoutingRecord = { decision: d, expectedHead: d.beforeSha, advanceHead: false };
          records.push(r);
          if (!b?.enabled || !b.deployOnPush) continue;
          const block = (code: string, message: string) => {
            d.decision = 'blocked';
            d.reasonCode = code;
            d.explanation = `${stack.name}: ${message}`;
          };
          if (!trusted) {
            block('signing_changed', 'Deployment blocked: signing credential or tracked branch changed.');
            continue;
          }
          if (!b.routingHeadSha || !b.routingPolicy || b.routingBranch !== conn.defaultBranch) {
            block(
              'baseline_required',
              'Deployment blocked: save automatic deployment settings again to establish a safe baseline.',
            );
            continue;
          }
          if (!local || conn.syncStatus !== 'ready') {
            block(
              'history_unavailable',
              'Deployment blocked: synchronized Git history is unavailable. Fetch and inspect before deploying manually.',
            );
            continue;
          }
          try {
            // The signed target is only an identifier: local commit objects and reachability authorize the diff.
            if (!(await this.history.isAncestor(local.cloneDir, source.afterSha, local.commitSha)))
              throw new Error('Target unavailable or rewritten.');
            if (await this.history.isAncestor(local.cloneDir, source.afterSha, b.routingHeadSha)) {
              d.reasonCode = 'already_processed';
              d.explanation = `${stack.name} skipped: this commit is already included in the saved routing baseline.`;
              continue;
            }
            let diff = diffCache.get(b.routingHeadSha);
            if (!diff) {
              diff = this.history.compareCommits(local.cloneDir, b.routingHeadSha, source.afterSha);
              diffCache.set(b.routingHeadSha, diff);
            }
            const paths = await diff;
            evaluationWork +=
              paths.reduce((sum, path) => sum + path.length, 0) *
              [
                ...b.routingPolicy.include,
                ...b.routingPolicy.exclude,
                ...b.routingPolicy.dependencies,
              ].reduce((sum, pattern) => sum + pattern.length, 0);
            if (evaluationWork > 100_000_000) throw new Error('Repository routing work limit exceeded.');
            const credential = await this.repos.credentials.findById(conn.workspaceId, b.credentialId);
            const decision = evaluateRouting(paths, {
              stackId: stack.id,
              rootPath: stack.rootPath,
              composePath: stack.composePath,
              enabled: b.enabled,
              deployOnPush: b.deployOnPush,
              policy: b.routingPolicy,
              credentialAvailable:
                credential?.kind === 'deployment' && credential.providerType === b.providerType,
            });
            d.matchedPaths = decision.matchedPaths;
            d.reasonCode = decision.reasonCode;
            d.explanation = `${stack.name}: ${decision.explanation}`;
            r.advanceHead = true;
            if (!decision.deployEligible) {
              if (decision.relevant) d.decision = 'blocked';
              continue;
            }
            if (b.automationHold) {
              block(
                'outcome_unknown',
                'Deployment outcome unknown: inspect the receiver, then use Deploy now deliberately. Automatic deployment is on hold.',
              );
              continue;
            }
            const id = this.newId();
            const queued = this.jobs.prepare(
              DEPLOYMENT_TRIGGER_JOB,
              { attemptId: id },
              { dedupeKey: `deployment:${stack.id}`, maxAttempts: 3 },
            );
            const attempt: DeploymentAttempt = {
              id,
              workspaceId: conn.workspaceId,
              stackId: stack.id,
              bindingId: b.id,
              providerType: b.providerType,
              actorUserId: null,
              triggerType: 'automatic',
              requestedAt: now,
              status: 'queued',
              httpStatus: null,
              reason: null,
              completedAt: null,
              bindingRevision: b.revision,
              credentialNonce: credential!.secretNonce,
              jobId: queued.id,
            };
            d.decision = 'deploy';
            d.attemptId = id;
            r.attempt = attempt;
            r.job = queued;
          } catch {
            block(
              'unsafe_history',
              'Deployment blocked: Git history is missing, rewritten, invalid or exceeds routing limits. Inspect and establish a new baseline deliberately.',
            );
          }
        }
        const saved = await this.repos.routing.record(
          source,
          records,
          { id: job.id, owner: job.leaseOwner },
          this.clock.now(),
        );
        for (const d of saved)
          await this.audit.record({
            action: d.decision === 'deploy' ? 'deployment.automatic_requested' : 'deployment.stack_skipped',
            outcome: d.decision === 'blocked' ? 'failure' : 'success',
            workspaceId: conn.workspaceId,
            entityType: 'stack',
            entityId: d.stackId,
            meta: { reasonCode: d.reasonCode, explanation: d.explanation, decisionId: d.id },
          });
        await this.audit.record({
          action: 'deployment.routing_evaluated',
          workspaceId: conn.workspaceId,
          entityType: 'repository',
          entityId: repositoryId,
          meta: { sourceDeliveryId: source.id, afterSha: source.afterSha, decisions: saved.length },
        });
      }
    }
    // Continue through the queue instead of monopolizing the worker on a large backlog.
    await this.schedule(repositoryId);
  }
  async schedule(repositoryId: string) {
    return this.jobs.enqueue(
      DEPLOYMENT_ROUTE_JOB,
      { repositoryId },
      { dedupeKey: `${DEPLOYMENT_ROUTE_JOB}:${repositoryId}`, followUpIfRunning: true },
    );
  }
}
