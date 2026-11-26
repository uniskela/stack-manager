import { isAppError } from '@/server/domain/errors';
import type { Logger } from '@/server/observability/logger';
import { safeErrorMessage } from '@/server/security/redact';
import { MAX_IMAGE_UPDATE_CANDIDATES, type ImageUpdateIntent } from '@/shared/image-update-planning';
import type { AuditService } from './audit-service';
import {
  IMAGE_UPDATE_POLICY_PATH,
  parseImageUpdatePolicy,
  policyExcludes,
  type ImageUpdatePolicy,
} from './image-update-policy';
import type { ImageUpdateService } from './image-update-service';
import type { StackRepository } from './ports';
import type { SourceService } from './source-service';

type AutomaticUpdateResult = 'skipped' | 'review' | 'ready' | 'published';

export class WudImageUpdateAutomation {
  constructor(
    private readonly stacks: Pick<StackRepository, 'list'>,
    private readonly source: Pick<SourceService, 'readFile'>,
    private readonly inventory: Pick<ImageUpdateService, 'queue'>,
    private readonly planner: {
      runAutomatic(
        workspaceId: string,
        stackId: string,
        candidates: ImageUpdateIntent[],
        signal: AbortSignal,
        reportOnly: boolean,
      ): Promise<AutomaticUpdateResult>;
    },
    private readonly audit: Pick<AuditService, 'record'>,
    private readonly logger: Pick<Logger, 'warn'>,
  ) {}

  async run(workspaceId: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const stacks = await this.stacks.list(workspaceId);
    const repositoryIds = new Set(stacks.map(({ repositoryId }) => repositoryId));
    const policies = await this.#policies(workspaceId, repositoryIds, signal);
    signal.throwIfAborted();
    if (policies.size === 0) return;

    const { inventory } = await this.inventory.queue(workspaceId);
    signal.throwIfAborted();
    const byId = new Map(stacks.map((stack) => [stack.id, stack]));
    const published = new Set<string>();
    for (const { stackId, sourceStatus, images } of inventory) {
      signal.throwIfAborted();
      const stack = byId.get(stackId);
      if (!stack || sourceStatus !== 'ready') continue;
      const policy = policies.get(stack.repositoryId);
      if (!policy?.automation) continue;
      const candidates: ImageUpdateIntent[] = [];
      for (const { name, status, candidateTag } of images) {
        if (status !== 'available' || !candidateTag || policyExcludes(policy, stack.composePath, name))
          continue;
        candidates.push({ stackId, service: name, source: 'wud', targetTag: candidateTag });
        if (candidates.length === MAX_IMAGE_UPDATE_CANDIDATES) break;
      }
      if (candidates.length === 0) continue;

      const { mode } = policy.automation;
      let result: AutomaticUpdateResult | 'failed' = 'skipped';
      try {
        if (mode === 'report' || !published.has(stack.repositoryId)) {
          result = await this.planner.runAutomatic(
            workspaceId,
            stackId,
            candidates,
            signal,
            mode === 'report',
          );
          if (result === 'published') published.add(stack.repositoryId);
        }
      } catch (error) {
        signal.throwIfAborted();
        this.logger.warn('WUD image update automation failed for a stack.', {
          workspaceId,
          stackId,
          error: safeErrorMessage(error),
        });
        result = 'failed';
      }
      await this.audit.record({
        action: 'wud.image_update_checked',
        workspaceId,
        entityType: 'stack',
        entityId: stackId,
        outcome: result === 'failed' ? 'failure' : 'success',
        meta: { mode, result, candidateCount: candidates.length },
      });
    }
    signal.throwIfAborted();
  }

  async #policies(workspaceId: string, repositoryIds: Set<string>, signal: AbortSignal) {
    const policies = new Map<string, ImageUpdatePolicy>();
    for (const repositoryId of repositoryIds) {
      signal.throwIfAborted();
      try {
        const file = await this.source.readFile(workspaceId, repositoryId, '', IMAGE_UPDATE_POLICY_PATH);
        if (!file.blobSha || file.locked || file.content === null) continue;
        const policy = parseImageUpdatePolicy(file.content);
        if (policy.automation && policy.sources.wud) policies.set(repositoryId, policy);
      } catch (error) {
        signal.throwIfAborted();
        if (isAppError(error) && error.status === 404) continue;
        this.logger.warn('Could not read WUD image update automation policy.', {
          workspaceId,
          repositoryId,
          error: safeErrorMessage(error),
        });
      }
    }
    return policies;
  }
}
