import type { Clock } from '@/server/domain/clock';
import { ConflictError, NotFoundError, ValidationError } from '@/server/domain/errors';
import {
  repoPathField,
  stackNameFromRoot,
  stackSlug,
  validateStackName,
  type Stack,
} from '@/server/domain/stack';
import type { SourceTreeReader } from '@/server/providers/git/types';
import { basename, COMPOSE_FILE_NAMES, dirname, isComposeFileName, isWithin } from '@/shared/source/paths';
import type { AuditService } from './audit-service';
import type { GitRepositoryService } from './git-repository-service';
import type { StackRepository } from './ports';

export interface StackView {
  id: string;
  name: string;
  slug: string;
  rootPath: string;
  composePath: string;
  repository: {
    id: string;
    name: string;
    defaultBranch: string;
    headSha: string | null;
    syncStatus: string;
  };
  createdAt: string;
}

export interface StackSuggestion {
  rootPath: string;
  composePath: string;
  name: string;
  /** Id of the stack already registered at this root, if any. */
  existingStackId: string | null;
}

export interface AddAllResult {
  /** Stacks registered by this call. */
  added: number;
  /** Compose folders that already had a stack. */
  existing: number;
  /** Folders that could not be registered, with the reason. */
  failed: { rootPath: string; message: string }[];
}

/** Directories never suggested as stacks (dependencies, CI config, VCS metadata). */
const IGNORED_SEGMENTS = new Set([
  'node_modules',
  'vendor',
  '.github',
  '.gitea',
  '.forgejo',
  '.git',
  'dist',
  'build',
]);
/** Folders listed in the UI and API; add-all and auto-add are not capped. */
const MAX_SUGGESTIONS = 2000;

/**
 * Explicit stacks inside connected repositories (docs/STACK_DISCOVERY.md). Discovery only suggests;
 * stacks exist once the operator confirms them, and never imply deploy/runtime bindings.
 */
export class StackService {
  constructor(
    private readonly repo: StackRepository,
    private readonly repositories: GitRepositoryService,
    private readonly reader: SourceTreeReader,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly newId: () => string,
  ) {}

  async list(workspaceId: string): Promise<StackView[]> {
    const stacks = await this.repo.list(workspaceId);
    return this.#views(workspaceId, stacks);
  }

  async listForRepository(workspaceId: string, repositoryId: string): Promise<StackView[]> {
    await this.repositories.get(workspaceId, repositoryId);
    return this.#views(workspaceId, await this.repo.listByRepository(workspaceId, repositoryId));
  }

  async get(workspaceId: string, id: string): Promise<StackView> {
    return (await this.#views(workspaceId, [await this.#find(workspaceId, id)]))[0]!;
  }

  /** Directories containing a Compose file at the fetched commit. Empty until the first fetch. */
  async suggest(workspaceId: string, repositoryId: string): Promise<StackSuggestion[]> {
    return (await this.#discover(workspaceId, repositoryId)).slice(0, MAX_SUGGESTIONS);
  }

  /** Every Compose folder at the fetched commit (uncapped: add-all must reach all of them). */
  async #discover(workspaceId: string, repositoryId: string): Promise<StackSuggestion[]> {
    const source = await this.repositories.localSource(workspaceId, repositoryId);
    if (!source) return [];
    const entries = await this.reader.listTree(source.cloneDir, source.commitSha);
    const existing = new Map(
      (await this.repo.listByRepository(workspaceId, repositoryId)).map((s) => [s.rootPath, s.id]),
    );
    const byDir = new Map<string, string>();
    for (const e of entries) {
      if (e.kind !== 'file' || !isComposeFileName(basename(e.path))) continue;
      const dir = dirname(e.path);
      if (dir.split('/').some((s) => IGNORED_SEGMENTS.has(s))) continue;
      const current = byDir.get(dir);
      // Prefer the canonical name order: compose.yaml, compose.yml, docker-compose.yaml, docker-compose.yml.
      if (!current || rank(e.path) < rank(current)) byDir.set(dir, e.path);
    }
    return [...byDir.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([rootPath, composePath]) => ({
        rootPath,
        composePath,
        name: stackNameFromRoot(rootPath, source.connection.name),
        existingStackId: existing.get(rootPath) ?? null,
      }));
  }

  async create(
    workspaceId: string,
    repositoryId: string,
    input: { name?: string; rootPath: string; composePath?: string },
    actorUserId: string,
  ): Promise<StackView> {
    const source = await this.repositories.localSource(workspaceId, repositoryId);
    if (!source) {
      throw new ConflictError('Fetch the repository before adding stacks.', 'not_synced');
    }
    const rootPath = repoPathField(input.rootPath, 'rootPath', { allowRoot: true });
    const entries = await this.reader.listTree(source.cloneDir, source.commitSha);
    const files = new Set(entries.filter((e) => e.kind === 'file').map((e) => e.path));
    if (rootPath !== '' && !entries.some((e) => e.path.startsWith(`${rootPath}/`))) {
      throw new ValidationError('Folder not found.', {
        rootPath: `No folder "${rootPath}" at the fetched commit.`,
      });
    }

    let composePath: string;
    if (input.composePath?.trim()) {
      composePath = repoPathField(input.composePath, 'composePath');
      if (!isWithin(rootPath, composePath) || !files.has(composePath)) {
        throw new ValidationError('Compose file not found.', {
          composePath: 'Choose a file inside the stack folder.',
        });
      }
    } else {
      const found = COMPOSE_FILE_NAMES.map((n) => (rootPath ? `${rootPath}/${n}` : n)).find((p) =>
        files.has(p),
      );
      if (!found) {
        throw new ValidationError('No Compose file in this folder.', {
          rootPath: `Expected one of ${COMPOSE_FILE_NAMES.join(', ')}.`,
        });
      }
      composePath = found;
    }

    const siblings = await this.repo.listByRepository(workspaceId, repositoryId);
    if (siblings.some((s) => s.rootPath === rootPath)) {
      throw new ConflictError('A stack already exists for this folder.', 'stack_exists');
    }
    const name = validateStackName(input.name?.trim() || stackNameFromRoot(rootPath, source.connection.name));
    const slugs = new Set(siblings.map((s) => s.slug));
    const id = await this.#insert(workspaceId, repositoryId, { name, rootPath, composePath }, slugs, {
      actorUserId,
    });
    return this.get(workspaceId, id);
  }

  /**
   * Registers every suggested Compose folder that is not a stack yet, in one call. Used by the
   * "Add all" action and, with a null actor, after each fetch of a repository with auto-add enabled.
   * Existing stacks are left as they are; folders that disappeared are never removed.
   */
  async addAll(workspaceId: string, repositoryId: string, actorUserId: string | null): Promise<AddAllResult> {
    const source = await this.repositories.localSource(workspaceId, repositoryId);
    if (!source) {
      throw new ConflictError('Fetch the repository before adding stacks.', 'not_synced');
    }
    const suggestions = await this.#discover(workspaceId, repositoryId);
    const slugs = new Set((await this.repo.listByRepository(workspaceId, repositoryId)).map((s) => s.slug));
    const result: AddAllResult = { added: 0, existing: 0, failed: [] };
    for (const s of suggestions) {
      if (s.existingStackId) {
        result.existing++;
        continue;
      }
      let name: string;
      try {
        name = validateStackName(s.name);
      } catch (error) {
        result.failed.push({ rootPath: s.rootPath, message: (error as Error).message });
        continue;
      }
      const input = { name, rootPath: s.rootPath, composePath: s.composePath };
      const origin = { actorUserId, auto: actorUserId === null };
      try {
        await this.#insert(workspaceId, repositoryId, input, slugs, origin);
        result.added++;
      } catch {
        // Another addAll (the post-fetch auto-add and the "Add all" button can overlap) may have registered
        // this folder, or taken the slug, since the suggestions were read: re-read and settle it.
        const current = await this.repo.listByRepository(workspaceId, repositoryId);
        if (current.some((x) => x.rootPath === s.rootPath)) {
          result.existing++;
          continue;
        }
        current.forEach((x) => slugs.add(x.slug));
        try {
          await this.#insert(workspaceId, repositoryId, input, slugs, origin);
          result.added++;
        } catch {
          result.failed.push({ rootPath: s.rootPath, message: 'Could not add this folder as a stack.' });
        }
      }
    }
    return result;
  }

  async update(
    workspaceId: string,
    id: string,
    input: { name?: string; composePath?: string },
    actorUserId: string,
  ): Promise<StackView> {
    const stack = await this.#find(workspaceId, id);
    const name = input.name === undefined ? undefined : validateStackName(input.name);
    let composePath: string | undefined;
    if (input.composePath !== undefined) {
      composePath = repoPathField(input.composePath, 'composePath');
      if (!isWithin(stack.rootPath, composePath)) {
        throw new ValidationError('Compose file must be inside the stack folder.', {
          composePath: 'Choose a file inside the stack folder.',
        });
      }
      const source = await this.repositories.localSource(workspaceId, stack.repositoryId);
      if (!source)
        throw new ConflictError('Fetch the repository before changing the Compose file.', 'not_synced');
      const entries = await this.reader.listTree(source.cloneDir, source.commitSha);
      if (!entries.some((e) => e.kind === 'file' && e.path === composePath)) {
        throw new ValidationError('Compose file not found.', {
          composePath: 'Choose a file that exists at the fetched commit.',
        });
      }
    }
    await this.repo.update(id, { name, composePath, updatedAt: this.clock.now() });
    await this.audit.record({
      action: 'stack.update',
      actorUserId,
      workspaceId,
      entityType: 'stack',
      entityId: id,
      meta: { name, composePath },
    });
    return this.get(workspaceId, id);
  }

  /** Removes the stack record only. Repository files and drafts are untouched. */
  async delete(workspaceId: string, id: string, actorUserId: string): Promise<void> {
    const stack = await this.#find(workspaceId, id);
    await this.repo.delete(id);
    await this.audit.record({
      action: 'stack.delete',
      actorUserId,
      workspaceId,
      entityType: 'stack',
      entityId: id,
      meta: { name: stack.name, rootPath: stack.rootPath },
    });
  }

  /** Inserts a stack with a slug unique among `slugs` (which is updated) and records the audit event. */
  async #insert(
    workspaceId: string,
    repositoryId: string,
    input: { name: string; rootPath: string; composePath: string },
    slugs: Set<string>,
    origin: { actorUserId: string | null; auto?: boolean },
  ): Promise<string> {
    const base = stackSlug(input.name);
    let slug = base;
    for (let i = 2; slugs.has(slug); i++) slug = `${base}-${i}`;
    slugs.add(slug);
    const now = this.clock.now();
    const stack: Stack = {
      id: this.newId(),
      workspaceId,
      repositoryId,
      ...input,
      slug,
      createdAt: now,
      updatedAt: now,
    };
    await this.repo.insert(stack);
    await this.audit.record({
      action: 'stack.create',
      actorUserId: origin.actorUserId,
      workspaceId,
      entityType: 'stack',
      entityId: stack.id,
      meta: { repositoryId, ...input, ...(origin.auto ? { auto: true } : {}) },
    });
    return stack.id;
  }

  async #find(workspaceId: string, id: string): Promise<Stack> {
    const stack = await this.repo.findById(workspaceId, id);
    if (!stack) throw new NotFoundError('Stack not found.');
    return stack;
  }

  async #views(workspaceId: string, stacks: Stack[]): Promise<StackView[]> {
    const repos = new Map((await this.repositories.list(workspaceId)).map((r) => [r.id, r]));
    return stacks.map((s) => {
      const r = repos.get(s.repositoryId);
      return {
        id: s.id,
        name: s.name,
        slug: s.slug,
        rootPath: s.rootPath,
        composePath: s.composePath,
        repository: {
          id: s.repositoryId,
          name: r?.name ?? 'Unknown repository',
          defaultBranch: r?.defaultBranch ?? '',
          headSha: r?.headSha ?? null,
          syncStatus: r?.syncStatus ?? 'error',
        },
        createdAt: s.createdAt.toISOString(),
      };
    });
  }
}

function rank(path: string): number {
  return COMPOSE_FILE_NAMES.indexOf(basename(path));
}
