import 'server-only';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AuditService } from '@/server/application/audit-service';
import { AuthService } from '@/server/application/auth-service';
import { CredentialService } from '@/server/application/credential-service';
import { GitRepositoryService, REPOSITORY_SYNC_JOB } from '@/server/application/git-repository-service';
import { JobQueue } from '@/server/application/job-queue';
import type { Repositories } from '@/server/application/ports';
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
import type { Resolver } from '@/server/security/network-policy';
import { SecretBox } from '@/server/security/secret-box';

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
  gitProviders: GitProviderRegistry;
  repositories: GitRepositoryService;
  jobs: JobQueue;
  worker: JobWorker;
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
    const gitProviders = createDefaultGitProviderRegistry(git);

    const audit = new AuditService(repos.audit, clock, newId, logger.child({ component: 'audit' }));
    const auth = new AuthService(repos.users, repos.sessions, audit, clock, newId, {
      sessionSecret: config.sessionSecret,
      sessionTtlMs: config.sessionTtlMs,
      setupToken: config.setupToken,
    });
    const workspaces = new WorkspaceService(repos.workspaces, audit, clock, newId);
    const credentials = new CredentialService(repos.credentials, box, audit, clock, newId, (kind, type) =>
      kind === 'git' ? gitProviders.has(type) : false,
    );
    const jobs = new JobQueue(repos.jobs, clock, newId);
    const repositories = new GitRepositoryService(
      repos.gitRepositories,
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
      },
    );

    const handlers = new Map<string, JobHandler>([
      [
        REPOSITORY_SYNC_JOB,
        async (job, ctx) => {
          const repositoryId = job.payload.repositoryId;
          if (typeof repositoryId !== 'string')
            throw new Error('repository_sync payload missing repositoryId');
          await repositories.sync(repositoryId, ctx.signal);
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

    return {
      config,
      logger,
      clock,
      repos,
      audit,
      auth,
      workspaces,
      credentials,
      gitProviders,
      repositories,
      jobs,
      worker,
      ping: () => pingSqlite(handle.db),
      close: async () => {
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
