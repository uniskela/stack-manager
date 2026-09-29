import type { AuditAction, AuditEvent } from '@/server/domain/audit';
import type { Clock } from '@/server/domain/clock';
import type { Logger } from '@/server/observability/logger';
import { redact } from '@/server/security/redact';
import type { AuditRepository } from './ports';

export interface AuditInput {
  action: AuditAction;
  outcome?: 'success' | 'failure';
  actorUserId?: string | null;
  workspaceId?: string | null;
  entityType?: string;
  entityId?: string;
  /** Free-form context. Always redacted before storage; sensitive keys are replaced, strings scrubbed. */
  meta?: Record<string, unknown>;
  /** Literal secret values in scope for this event; scrubbed if they appear anywhere in `meta`. */
  knownSecrets?: ReadonlyArray<string | null | undefined>;
}

/**
 * Audit trail with redaction as the default: there is no API that stores metadata unredacted.
 * Audit writes never fail the calling operation; failures are logged (redacted) instead.
 */
export class AuditService {
  constructor(
    private readonly repo: AuditRepository,
    private readonly clock: Clock,
    private readonly newId: () => string,
    private readonly logger: Logger,
  ) {}

  async record(input: AuditInput): Promise<void> {
    const event: AuditEvent = {
      id: this.newId(),
      createdAt: this.clock.now(),
      actorUserId: input.actorUserId ?? null,
      workspaceId: input.workspaceId ?? null,
      action: input.action,
      outcome: input.outcome ?? 'success',
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      meta: redact(input.meta ?? {}, { secrets: input.knownSecrets }) as Record<string, unknown>,
    };
    try {
      await this.repo.insert(event);
    } catch (error) {
      this.logger.error('audit write failed', { action: input.action, error });
    }
  }

  list(filter: { workspaceId?: string; limit?: number }): Promise<AuditEvent[]> {
    return this.repo.list({ workspaceId: filter.workspaceId, limit: Math.min(filter.limit ?? 50, 200) });
  }
}
