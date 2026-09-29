import type { Clock } from '@/server/domain/clock';
import { NotFoundError } from '@/server/domain/errors';
import { slugify, validateWorkspaceName, type Workspace } from '@/server/domain/workspace';
import type { AuditService } from './audit-service';
import type { WorkspaceRepository } from './ports';

/**
 * Workspaces are first-class and addressed by id everywhere, so multiple workspaces remain possible
 * even though the MVP UI guides operators through a single one.
 */
export class WorkspaceService {
  constructor(
    private readonly repo: WorkspaceRepository,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly newId: () => string,
  ) {}

  async create(input: { name: string }, actorUserId: string): Promise<Workspace> {
    const name = validateWorkspaceName(input.name);
    const base = slugify(name);
    let slug = base;
    for (let i = 2; await this.repo.slugExists(slug); i++) slug = `${base}-${i}`;
    const now = this.clock.now();
    const workspace: Workspace = { id: this.newId(), name, slug, createdAt: now, updatedAt: now };
    await this.repo.insert(workspace);
    await this.audit.record({
      action: 'workspace.create',
      actorUserId,
      workspaceId: workspace.id,
      entityType: 'workspace',
      entityId: workspace.id,
      meta: { name },
    });
    return workspace;
  }

  list(): Promise<Workspace[]> {
    return this.repo.list();
  }

  async get(id: string): Promise<Workspace> {
    const workspace = await this.repo.findById(id);
    if (!workspace) throw new NotFoundError('Workspace not found.');
    return workspace;
  }

  async rename(id: string, input: { name: string }, actorUserId: string): Promise<Workspace> {
    const workspace = await this.get(id);
    const name = validateWorkspaceName(input.name);
    const updatedAt = this.clock.now();
    await this.repo.update(id, { name, updatedAt });
    await this.audit.record({
      action: 'workspace.update',
      actorUserId,
      workspaceId: id,
      entityType: 'workspace',
      entityId: id,
      meta: { from: workspace.name, to: name },
    });
    return { ...workspace, name, updatedAt };
  }
}
