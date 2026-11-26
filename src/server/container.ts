import 'server-only';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AuditService } from '@/server/application/audit-service';
import { AuthService } from '@/server/application/auth-service';
import {
  DeploymentRoutingService,
  DEPLOYMENT_ROUTE_JOB,
} from '@/server/application/deployment-routing-service';
import { DeploymentService, DEPLOYMENT_TRIGGER_JOB } from '@/server/application/deployment-service';
import { createDeploymentProviders } from '@/server/providers/deployment/registry';
import { ValidationError } from '@/server/domain/errors';
import { CredentialService } from '@/server/application/credential-service';
import { GitRepositoryService, REPOSITORY_SYNC_JOB } from '@/server/application/git-repository-service';
import { GitWorkflowService } from '@/server/application/git-workflow-service';
import { GitHistoryService } from '@/server/application/git-history-service';
import { GitWebhookService } from '@/server/application/git-webhook-service';
import { JobQueue } from '@/server/application/job-queue';
import { ImageUpdateService, WUD_REFRESH_JOB } from '@/server/application/image-update-service';
import { ImageUpdateStagingService } from '@/server/application/image-update-staging-service';
import { WudImageUpdatePublication } from '@/server/application/wud-image-update-publication';
import { WudImageUpdateReview } from '@/server/application/wud-image-update-review';
import { WudImageUpdateAutomation } from '@/server/application/wud-image-update-automation';
import { RepositoryAutoFetch } from '@/server/application/repository-auto-fetch';
import type { Repositories } from '@/server/application/ports';
import { SourceService } from '@/server/application/source-service';
import { StackService } from '@/server/application/stack-service';
import { WorkspaceService } from '@/server/application/workspace-service';
import { loadConfig, type AppConfig } from '@/server/config/config';
import { systemClock, type Clock } from '@/server/domain/clock';
import { JobWorker, type JobHandler, type JobWorkerOptions } from '@/server/jobs/worker';
import { createLogger, type Logger } from '@/server/observability/logger';
import {
  openSqlite,
  pingSqlite,
  runMigrations,
  type SqliteHandle,
} from '@/server/persistence/sqlite/database';
import { createSqliteRepositories } from '@/server/persistence/sqlite/repositories';
import { GitCli } from '@/server/providers/git/git-cli';
import { createDefaultGitProviderRegistry, type GitProviderRegistry } from '@/server/providers/git/registry';
import { GitSourceReader } from '@/server/providers/git/source-reader';
import { GitHistoryReader } from '@/server/providers/git/history-reader';
import { GiteaImageUpdatePulls } from '@/server/providers/git/gitea-image-update-pulls';
import { WudClient } from '@/server/providers/wud/client';
import { ChangelogReader } from '@/server/providers/changelog/reader';
import type { Resolver } from '@/server/security/network-policy';
import { SecretBox } from '@/server/security/secret-box';
import { safeErrorMessage } from '@/server/security/redact';

/**
 * Composition root. Wires config → persistence adapters → services → providers → worker.
 * Nothing else constructs services, so tests can build an isolated container per case.
 */
export interface Container {
  config: AppConfig;
  logger: Logger;
  clock: Clock;
  repos: Repositories;
  audit: AuditService;
  auth: AuthService;
  workspaces: WorkspaceService;
  credentials: CredentialService;
  deployments: DeploymentService;
  deploymentRouting: DeploymentRoutingService;
  gitProviders: GitProviderRegistry;
  repositories: GitRepositoryService;
  stacks: StackService;
  source: SourceService;
  gitWorkflow: GitWorkflowService;
  gitHistory: GitHistoryService;
  gitWebhooks: GitWebhookService;
  jobs: JobQueue;
  worker: JobWorker;
  autoFetch: RepositoryAutoFetch;
  imageUpdates: ImageUpdateService;
  imageUpdateStaging: ImageUpdateStagingService;
  wudImageUpdateReview: WudImageUpdateReview;
  ping(): boolean;
  close(): Promise<void>;
}

export interface ContainerOverrides {
  clock?: Clock;
  logger?: Logger;
  gitAllowedProtocols?: readonly string[];
  gitExtraConfig?: ReadonlyArray<readonly [string, string]>;
  resolver?: Resolver;
  workerOptions?: JobWorkerOptions;
  migrationsFolder?: string;
  wudClient?: Pick<WudClient, 'read'>;
  changelog?: Pick<ChangelogReader, 'check'>;
  imageUpdatePulls?: Pick<GiteaImageUpdatePulls, 'list' | 'create' | 'get' | 'close'>;
}

/** Ensures the data directory layout exists with owner-only permissions. */
export function prepareDataDir(config: AppConfig): void {
  for (const dir of [config.dataDir, config.reposDir, path.join(config.dataDir, 'git-home')]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  fs.accessSync(config.dataDir, fs.constants.R_OK | fs.constants.W_OK);
}

export function createContainer(config: AppConfig, overrides: ContainerOverrides = {}): Container {
  const logger =
    overrides.logger ?? createLogger({ level: config.logLevel, bindings: { service: 'stack-manager' } });
  const clock = overrides.clock ?? systemClock;
  const newId = () => randomUUID();

  prepareDataDir(config);
  const handle: SqliteHandle = openSqlite(config.databasePath);
  try {
    runMigrations(handle.db, overrides.migrationsFolder);
    const repos = createSqliteRepositories(handle.db);

    const box = new SecretBox(config.encryption);
    const git = new GitCli({
      homeDir: path.join(config.dataDir, 'git-home'),
      allowedProtocols: overrides.gitAllowedProtocols ?? ['https'],
      extraConfig: overrides.gitExtraConfig,
    });
    const gitProviders = createDefaultGitProviderRegistry(git, config.reposDir);

    const audit = new AuditService(repos.audit, clock, newId, logger.child({ component: 'audit' }));
    const auth = new AuthService(repos.users, repos.sessions, audit, clock, newId, {
      sessionSecret: config.sessionSecret,
      sessionTtlMs: config.sessionTtlMs,
      setupToken: config.setupToken,
    });
    const workspaces = new WorkspaceService(repos.workspaces, audit, clock, newId);
    const deploymentProviders = createDeploymentProviders({
      allowPrivateNetworks: config.allowPrivateNetworks,
      resolver: overrides.resolver,
    });
    const credentials = new CredentialService(
      repos.credentials,
      box,
      audit,
      clock,
      newId,
      (kind, type) =>
        kind === 'git' || kind === 'git_webhook'
          ? gitProviders.has(type)
          : (kind === 'deployment' &&
              deploymentProviders.has(type as 'portainer-webhook' | 'generic-webhook')) ||
            (kind === 'image_update' && type === 'wud'),
      async (type, secret) => {
        const provider = deploymentProviders.get(type as 'portainer-webhook' | 'generic-webhook');
        if (!provider) throw new ValidationError('Unsupported deployment provider.');
        let value: unknown;
        try {
          value = JSON.parse(secret);
        } catch {
          throw new ValidationError('Invalid deployment configuration.');
        }
        const configuration = provider.validateConfiguration(value);
        await provider.validateDestination(configuration);
        return JSON.stringify(configuration);
      },
    );
    const jobs = new JobQueue(repos.jobs, clock, newId);
    const deployments = new DeploymentService(
      repos,
      credentials,
      deploymentProviders,
      jobs,
      audit,
      clock,
      newId,
    );
    const gitWebhooks = new GitWebhookService(
      repos.gitRepositories,
      credentials,
      repos.credentials,
      repos.gitWebhookDeliveries,
      jobs,
      audit,
      clock,
      newId,
    );
    const reader = new GitSourceReader(git);
    const repositories = new GitRepositoryService(
      repos.gitRepositories,
      repos.drafts,
      reader,
      credentials,
      gitProviders,
      jobs,
      audit,
      clock,
      newId,
      logger.child({ component: 'git' }),
      {
        dataDir: config.dataDir,
        reposDir: config.reposDir,
        allowPrivateNetworks: config.allowPrivateNetworks,
        resolver: overrides.resolver,
        fetchPolicy: config,
      },
    );

    const stacks = new StackService(repos.stacks, repositories, reader, audit, clock, newId);
    const source = new SourceService(repositories, reader, repos.drafts, repos.stacks, audit, clock, newId);
    const imageUpdates = new ImageUpdateService(
      repos.wud,
      repos.workspaces,
      repos.stacks,
      source,
      credentials,
      overrides.wudClient ??
        new WudClient({ allowPrivateNetworks: config.allowPrivateNetworks, resolver: overrides.resolver }),
      jobs,
      audit,
      clock,
      newId,
      config.workerEnabled,
    );
    const giteaPulls = new GiteaImageUpdatePulls({
      allowPrivateNetworks: config.allowPrivateNetworks,
      resolver: overrides.resolver,
    });
    const publication = new WudImageUpdatePublication(
      repos.gitRepositories,
      repositories,
      repos.users,
      overrides.imageUpdatePulls ?? giteaPulls,
      audit,
    );
    const wudImageUpdateReview = new WudImageUpdateReview(
      repos.gitRepositories,
      repositories,
      giteaPulls,
      audit,
    );
    const imageUpdateStaging = new ImageUpdateStagingService(
      repos.stacks,
      source,
      imageUpdates,
      overrides.changelog ?? new ChangelogReader(),
      clock,
      config.sessionSecret,
      publication,
    );
    const imageUpdateAutomation = new WudImageUpdateAutomation(
      repos.stacks,
      source,
      imageUpdates,
      imageUpdateStaging,
      audit,
      logger.child({ component: 'image-updates' }),
    );
    const historyReader = new GitHistoryReader(git, config.reposDir);
    const deploymentRouting = new DeploymentRoutingService(
      repos,
      repositories,
      historyReader,
      jobs,
      audit,
      clock,
      newId,
    );
    const gitHistory = new GitHistoryService(repositories, historyReader, reader);
    const gitWorkflow = new GitWorkflowService(
      repositories,
      repos.drafts,
      repos.stacks,
      repos.users,
      reader,
      audit,
    );

    const syncLogger = logger.child({ component: 'stacks' });
    const handlers = new Map<string, JobHandler>([
      [
        WUD_REFRESH_JOB,
        async (job, ctx) => {
          const refreshed = await imageUpdates.refresh(job, ctx.signal);
          if (refreshed && typeof job.payload.workspaceId === 'string') {
            await imageUpdateAutomation.run(job.payload.workspaceId, ctx.signal);
          }
        },
      ],
      [DEPLOYMENT_ROUTE_JOB, (job, ctx) => deploymentRouting.execute(job, ctx)],
      [DEPLOYMENT_TRIGGER_JOB, (job, ctx) => deployments.execute(job, ctx)],
      [
        REPOSITORY_SYNC_JOB,
        async (job, ctx) => {
          const repositoryId = job.payload.repositoryId;
          if (typeof repositoryId !== 'string')
            throw new Error('repository_sync payload missing repositoryId');
          await repositories.sync(repositoryId, ctx.signal);
          const continuation = (await repos.routing.hasPending(repositoryId))
            ? jobs.prepare(
                DEPLOYMENT_ROUTE_JOB,
                { repositoryId },
                { dedupeKey: `${DEPLOYMENT_ROUTE_JOB}:${repositoryId}`, followUpIfRunning: true },
              )
            : undefined;
          // Keep stacks in step with the repository. A failure here must not fail the fetch itself.
          const conn = await repos.gitRepositories.findByIdUnscoped(repositoryId);
          if (!conn?.autoAddStacks) return continuation;
          try {
            const result = await stacks.addAll(conn.workspaceId, conn.id, null);
            if (result.failed.length > 0)
              syncLogger.warn('some stacks could not be added automatically', {
                repositoryId,
                failed: result.failed.length,
              });
          } catch (error) {
            syncLogger.warn('automatic stack registration failed', {
              repositoryId,
              error: safeErrorMessage(error),
            });
          }
          return continuation;
        },
      ],
    ]);
    const worker = new JobWorker(
      repos.jobs,
      handlers,
      clock,
      logger.child({ component: 'jobs' }),
      overrides.workerOptions,
    );
    const autoFetch = new RepositoryAutoFetch(
      repos.workspaces,
      repos.gitRepositories,
      jobs,
      clock,
      logger.child({ component: 'auto-fetch' }),
      config,
    );

    return {
      config,
      logger,
      clock,
      repos,
      audit,
      auth,
      workspaces,
      credentials,
      deployments,
      deploymentRouting,
      gitProviders,
      repositories,
      stacks,
      source,
      gitWorkflow,
      gitHistory,
      jobs,
      gitWebhooks,
      worker,
      autoFetch,
      imageUpdates,
      imageUpdateStaging,
      wudImageUpdateReview,
      ping: () => pingSqlite(handle.db),
      close: async () => {
        await autoFetch.stop();
        await imageUpdates.stop();
        await worker.stop();
        handle.close();
      },
    };
  } catch (error) {
    // Do not leak the SQLite handle (and its WAL lock) when wiring fails after opening it.
    handle.close();
    throw error;
  }
}

const GLOBAL_KEY = Symbol.for('stack-manager.container');
type GlobalWithContainer = typeof globalThis & { [GLOBAL_KEY]?: Container };

/**
 * Process-wide container. Stored on globalThis because Next.js compiles instrumentation and route
 * bundles separately; module-level singletons would otherwise be duplicated.
 */
export function getContainer(): Container {
  const g = globalThis as GlobalWithContainer;
  g[GLOBAL_KEY] ??= createContainer(loadConfig());
  return g[GLOBAL_KEY];
}

export function setContainer(container: Container | undefined): void {
  (globalThis as GlobalWithContainer)[GLOBAL_KEY] = container;
}
