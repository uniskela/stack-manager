import {
  discoverWudMappings,
  inspectStackImages,
  matchImageUpdates,
  type StackImageUpdate,
  type WudBinding,
  type WudMappingSelection,
  type WudMappingSaveResult,
} from '@/shared/image-updates';
import type { Clock } from '@/server/domain/clock';
import { ConflictError, isAppError, NotFoundError, ValidationError } from '@/server/domain/errors';
import type { Job } from '@/server/domain/job';
import type { Stack } from '@/server/domain/stack';
import type { Logger } from '@/server/observability/logger';
import { wudBaseUrl, WUD_IDENTIFIER, WUD_TOKEN, type WudClient } from '@/server/providers/wud/client';
import type { AuditService } from './audit-service';
import type { CredentialService } from './credential-service';
import type { JobQueue } from './job-queue';
import type { StackRepository, WorkspaceRepository } from './ports';
import type { SourceService } from './source-service';
import type { WudConnection, WudRepository } from './wud-ports';

export const WUD_REFRESH_JOB = 'wud_refresh';
const REFRESH_INTERVAL_MS = 15 * 60 * 1000;
const CREDENTIAL = { kind: 'image_update', providerType: 'wud' } as const;

const connectionView = (connection: WudConnection) => ({
  revision: connection.revision,
  baseUrl: connection.baseUrl,
  lastSuccessAt: connection.lastSuccessAt.toISOString(),
  lastError: connection.lastError,
});

const bindingView = (binding: WudBinding | null) =>
  binding && { watcher: binding.watcher, project: binding.project };

interface StackInventory {
  stackId: string;
  stackName: string;
  binding: WudBinding | null;
  sourceStatus: 'ready' | 'unavailable' | 'invalid';
  images: StackImageUpdate[];
}

export class ImageUpdateService {
  #timer: ReturnType<typeof setInterval> | null = null;
  #scan: Promise<void> | null = null;

  constructor(
    private readonly repo: WudRepository,
    private readonly workspaces: WorkspaceRepository,
    private readonly stacks: StackRepository,
    private readonly source: Pick<SourceService, 'readFile'>,
    private readonly credentials: CredentialService,
    private readonly client: Pick<WudClient, 'read'>,
    private readonly jobs: JobQueue,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly newId: () => string,
    private readonly workerEnabled: boolean,
  ) {}

  async settings(workspaceId: string) {
    await this.#requireWorkspace(workspaceId);
    const connection = await this.repo.connection(workspaceId);
    if (!connection) return { connection: null, refreshing: false };
    const job = await this.jobs.latestFor(this.#dedupeKey(connection));
    return {
      connection: connectionView(connection),
      refreshing: job?.status === 'pending' || job?.status === 'running',
    };
  }

  async configure(
    workspaceId: string,
    input: { baseUrl: string; token: string; expectedRevision: string | null },
    actorUserId: string,
  ) {
    await this.#requireWorkspace(workspaceId);
    if (!WUD_TOKEN.test(input.token)) throw new ValidationError('Enter a valid WUD read token.');
    const baseUrl = wudBaseUrl(input.baseUrl);
    const observations = await this.client.read(baseUrl, input.token);
    const credential = await this.credentials.prepare(
      { workspaceId, ...CREDENTIAL, label: 'WUD read token', secret: input.token },
      actorUserId,
    );
    const now = this.clock.now();
    const connection = {
      workspaceId,
      baseUrl,
      credentialId: credential.id,
      revision: this.newId(),
      observations,
      lastSuccessAt: now,
      lastAttemptAt: now,
      lastError: null,
    };
    await this.repo.saveConnection(connection, credential, input.expectedRevision);
    await this.audit.record({
      action: 'wud.connection_saved',
      actorUserId,
      workspaceId,
      entityType: 'workspace',
      entityId: workspaceId,
    });
    return connectionView(connection);
  }

  async remove(workspaceId: string, expectedRevision: string, actorUserId: string) {
    await this.#requireWorkspace(workspaceId);
    await this.repo.removeConnection(workspaceId, expectedRevision);
    await this.audit.record({
      action: 'wud.connection_removed',
      actorUserId,
      workspaceId,
      entityType: 'workspace',
      entityId: workspaceId,
    });
  }

  async requestRefresh(workspaceId: string) {
    if (!this.workerEnabled) throw new ConflictError('The background worker is disabled.');
    const connection = await this.repo.connection(workspaceId);
    if (!connection) throw new NotFoundError('WUD connection not found.');
    return { jobId: (await this.#enqueue(connection)).job.id };
  }

  async refresh(job: Job, signal: AbortSignal): Promise<void> {
    const { workspaceId, revision } = job.payload;
    if (typeof workspaceId !== 'string' || typeof revision !== 'string')
      throw new Error('Invalid WUD refresh job');
    const connection = await this.repo.connection(workspaceId);
    if (connection?.revision !== revision) return;
    const attemptedAt = this.clock.now();
    let observations;
    try {
      observations = await this.credentials.withPlaintext(
        workspaceId,
        connection.credentialId,
        (token) => this.client.read(connection.baseUrl, token, signal),
        CREDENTIAL,
      );
      signal.throwIfAborted();
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      await this.repo.recordRefresh(workspaceId, revision, attemptedAt, {
        error: isAppError(error) && error.code === 'wud_auth_failed' ? 'auth' : 'unavailable',
      });
      throw new Error('WUD refresh failed.');
    }
    await this.repo.recordRefresh(workspaceId, revision, attemptedAt, { observations });
  }

  start(logger: Pick<Logger, 'warn'>): void {
    if (this.#timer || !this.workerEnabled) return;
    const scan = () => {
      if (this.#scan) return;
      this.#scan = this.#scheduleDue()
        .then((results) => {
          for (const { workspaceId, status } of results) {
            if (status === 'failed') logger.warn('Could not schedule WUD refresh.', { workspaceId });
          }
        })
        .catch(() => logger.warn('Could not schedule WUD refreshes.'))
        .finally(() => {
          this.#scan = null;
        });
    };
    scan();
    this.#timer = setInterval(scan, 60_000);
    this.#timer.unref();
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    await this.#scan;
  }

  async stack(workspaceId: string, stackId: string) {
    const stack = await this.#requireStack(workspaceId, stackId);
    const [connection, binding] = await Promise.all([
      this.repo.connection(workspaceId),
      this.stackBinding(workspaceId, stackId),
    ]);
    return { connected: connection !== null, ...(await this.#inventory(stack, binding, connection)) };
  }

  async stackBinding(workspaceId: string, stackId: string): Promise<WudBinding | null> {
    const bindings = await this.repo.bindings(workspaceId);
    return bindingView(bindings.find((row) => row.stackId === stackId) ?? null);
  }

  async setBinding(workspaceId: string, stackId: string, binding: WudBinding | null, actorUserId: string) {
    await this.#requireStack(workspaceId, stackId);
    if (binding && (!WUD_IDENTIFIER.test(binding.watcher) || !WUD_IDENTIFIER.test(binding.project)))
      throw new ValidationError('Enter a WUD watcher and Docker Compose project name.');
    await this.repo.setBinding(workspaceId, stackId, binding);
    await this.#auditBinding(workspaceId, stackId, actorUserId, binding !== null);
  }

  async #auditBinding(workspaceId: string, stackId: string, actorUserId: string, configured: boolean) {
    await this.audit.record({
      action: 'wud.stack_binding_updated',
      actorUserId,
      workspaceId,
      entityType: 'stack',
      entityId: stackId,
      meta: { configured },
    });
  }

  async discoverMappings(workspaceId: string, choiceStackId?: string) {
    const { inputs, bindings, connection, now } = await this.#mappingSources(workspaceId);
    return discoverWudMappings(inputs, bindings, connection.observations, now, choiceStackId);
  }

  async saveDiscoveredMappings(
    workspaceId: string,
    selected: readonly WudMappingSelection[],
    actorUserId: string,
    confirmChoice = false,
  ): Promise<WudMappingSaveResult> {
    const { sources, inputs, bindings, connection, now } = await this.#mappingSources(workspaceId);
    const choiceStackId = confirmChoice && selected.length === 1 ? selected[0]?.stackId : undefined;
    const { suggestions, choices } = discoverWudMappings(
      inputs,
      bindings,
      connection.observations,
      now,
      choiceStackId,
    );
    const suggested = new Map(suggestions.map((match) => [match.stackId, match]));
    const byStack = new Map(sources.map(({ stack, file }) => [stack.id, { stack, file }]));
    const results = await Promise.all(
      selected.map(async (selection): Promise<WudMappingSaveResult['results'][number]> => {
        const { stackId, watcher, project } = selection;
        const match = suggested.get(stackId);
        const source = byStack.get(stackId);
        const eligible = stackId === choiceStackId && choices.length ? choices : [match];
        if (!source?.file || !eligible.some((item) => item?.watcher === watcher && item.project === project))
          return { stackId, status: 'changed' };
        try {
          const saved = await this.repo.saveDiscoveredBinding(
            workspaceId,
            connection,
            { ...source.stack, commitSha: source.file.commitSha },
            { watcher, project },
          );
          return { stackId, status: saved ? 'saved' : 'changed' };
        } catch {
          return { stackId, status: 'failed' };
        }
      }),
    );
    // Audit write failures are logged by AuditService. An audit rejection cannot undo a saved mapping.
    await Promise.allSettled(
      results
        .filter(({ status }) => status === 'saved')
        .map(({ stackId }) => this.#auditBinding(workspaceId, stackId, actorUserId, true)),
    );
    return { results };
  }

  async #mappingSources(workspaceId: string) {
    await this.#requireWorkspace(workspaceId);
    const [connection, bindings, stacks] = await Promise.all([
      this.repo.connection(workspaceId),
      this.repo.bindings(workspaceId),
      this.stacks.list(workspaceId),
    ]);
    const now = this.clock.now();
    requireFreshMappingSnapshot(connection, now);
    const linked = new Set(bindings.map(({ stackId }) => stackId));
    const unbound = stacks.filter(({ id }) => !linked.has(id));
    const sources = await readStacks(unbound, async (stack) => ({
      stack,
      file: await this.#readImages(stack).catch(() => null),
    }));
    const inputs = sources.map(({ stack, file }) => ({
      stackId: stack.id,
      stackName: stack.name,
      images: file?.images ?? [],
    }));
    return { inputs, sources, bindings, connection, now };
  }

  async queue(workspaceId: string) {
    await this.#requireWorkspace(workspaceId);
    const [connection, bindings, stacks] = await Promise.all([
      this.repo.connection(workspaceId),
      this.repo.bindings(workspaceId),
      this.stacks.list(workspaceId),
    ]);
    const byStackId = new Map(bindings.map((binding) => [binding.stackId, binding]));
    const bound = stacks.filter((stack) => byStackId.has(stack.id));
    const inventory = await readStacks(bound, (stack) => {
      const binding = byStackId.get(stack.id) ?? null;
      return this.#inventory(stack, binding, connection).catch(() => ({
        stackId: stack.id,
        stackName: stack.name,
        binding: bindingView(binding),
        sourceStatus: 'unavailable',
        images: [],
      }));
    });
    return { inventory, unboundCount: stacks.length - bound.length };
  }

  async #inventory(
    stack: Stack,
    binding: WudBinding | null,
    connection: WudConnection | null,
  ): Promise<StackInventory> {
    const file = await this.#readImages(stack);
    const parsedStatus = file?.images ? 'ready' : 'invalid';
    const sourceStatus = file ? parsedStatus : 'unavailable';
    const now = this.clock.now();
    const activeBinding = connection ? binding : null;
    const images = file?.images
      ? matchImageUpdates(
          file.images,
          activeBinding,
          connection?.observations ?? [],
          now,
          isStaleSnapshot(connection, now),
        )
      : [];
    return { stackId: stack.id, stackName: stack.name, binding: bindingView(binding), sourceStatus, images };
  }

  async #readImages(stack: Stack) {
    try {
      const file = await this.source.readFile(
        stack.workspaceId,
        stack.repositoryId,
        stack.rootPath,
        stack.composePath,
      );
      if (file.locked || file.content === null) return null;
      return { images: inspectStackImages(file.content), commitSha: file.commitSha };
    } catch (error) {
      if (!isAppError(error) || (error.status !== 404 && error.status !== 409)) throw error;
      return null;
    }
  }

  async #requireWorkspace(workspaceId: string): Promise<void> {
    if (!(await this.workspaces.findById(workspaceId))) throw new NotFoundError('Workspace not found.');
  }

  async #requireStack(workspaceId: string, stackId: string): Promise<Stack> {
    const stack = await this.stacks.findById(workspaceId, stackId);
    if (!stack) throw new NotFoundError('Stack not found.');
    return stack;
  }

  async #scheduleDue() {
    const cutoff = new Date(this.clock.now().getTime() - REFRESH_INTERVAL_MS);
    const due = await this.repo.dueConnections(cutoff);
    return Promise.all(
      due.map(async (connection) => {
        const { workspaceId } = connection;
        try {
          const { created } = await this.#enqueue(connection);
          return { workspaceId, status: created ? 'scheduled' : 'already_scheduled' };
        } catch {
          return { workspaceId, status: 'failed' };
        }
      }),
    );
  }

  #enqueue(connection: Pick<WudConnection, 'workspaceId' | 'revision'>) {
    const { workspaceId, revision } = connection;
    return this.jobs.enqueue(
      WUD_REFRESH_JOB,
      { workspaceId, revision },
      {
        dedupeKey: this.#dedupeKey(connection),
        maxAttempts: 3,
      },
    );
  }

  #dedupeKey({ workspaceId, revision }: Pick<WudConnection, 'workspaceId' | 'revision'>): string {
    return `${WUD_REFRESH_JOB}:${workspaceId}:${revision}`;
  }
}

function isStaleSnapshot(connection: WudConnection | null, now: Date) {
  return (
    connection?.lastError !== null ||
    now.getTime() - connection.lastSuccessAt.getTime() >= 2 * REFRESH_INTERVAL_MS
  );
}

function requireFreshMappingSnapshot(
  connection: WudConnection | null,
  now: Date,
): asserts connection is WudConnection {
  if (!connection) throw new ConflictError('Connect WUD before finding stack matches.', 'wud_not_connected');
  if (connection.lastError === 'auth')
    throw new ConflictError('WUD refused the read token.', 'wud_auth_failed');
  if (connection.lastError === 'unavailable')
    throw new ConflictError('The last refresh could not read WUD.', 'wud_unavailable');
  if (isStaleSnapshot(connection, now))
    throw new ConflictError('The saved WUD data is out of date.', 'wud_snapshot_stale');
}

async function readStacks<T>(stacks: readonly Stack[], read: (stack: Stack) => Promise<T>): Promise<T[]> {
  const results: T[] = [];
  let next = 0;
  async function readNext(): Promise<void> {
    const index = next++;
    const stack = stacks[index];
    if (!stack) return;
    results[index] = await read(stack);
    return readNext();
  }
  await Promise.all(Array.from({ length: Math.min(stacks.length, 8) }, readNext));
  return results;
}
