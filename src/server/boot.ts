import 'server-only';
import { ConfigError } from '@/server/config/config';
import { createLogger } from '@/server/observability/logger';
import { getContainer } from './container';

/**
 * Server start-up (called from src/instrumentation.ts before any request is served):
 * validate configuration (fail closed), prepare the data dir, run migrations, start the job worker.
 */
export async function boot(): Promise<void> {
  let container;
  try {
    container = getContainer();
  } catch (error) {
    const bootLogger = createLogger({ bindings: { service: 'stack-manager' } });
    bootLogger.error(
      error instanceof ConfigError ? 'invalid configuration; refusing to start' : 'startup failed',
      {
        error,
      },
    );
    process.exit(1);
  }
  const { logger, config, auth, worker } = container;
  logger.info('stack-manager ready', {
    dataDir: config.dataDir,
    keyVersion: config.encryption.keyVersion,
    cookieSecure: config.cookieSecure,
    allowPrivateNetworks: config.allowPrivateNetworks,
  });
  if (await auth.isSetupRequired()) {
    logger.warn('first-run setup pending: open the app to create the admin account', {
      setupTokenRequired: auth.setupTokenRequired,
    });
  }
  if (config.workerEnabled) worker.start();

  const purge = setInterval(() => {
    auth.purgeExpiredSessions().catch((error) => logger.error('session purge failed', { error }));
  }, 60 * 60_000);
  purge.unref();

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info('shutting down', { signal });
    container
      .close()
      .catch((error) => logger.error('shutdown error', { error }))
      .finally(() => process.exit(0));
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}
