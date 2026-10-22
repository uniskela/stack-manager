import { randomUUID } from 'node:crypto';
import { vi, type Mock } from 'vitest';
import { DeploymentService } from '@/server/application/deployment-service';
import { openSqlite } from '@/server/persistence/sqlite/database';
import type { TestHarness } from './container';

/** Runs one statement on an independent SQLite connection, returning rows for readers. */
export function sqlRows<T = Record<string, unknown>>(
  h: TestHarness,
  statement: string,
  ...values: unknown[]
): T[] {
  const handle = openSqlite(h.config.databasePath);
  try {
    const prepared = handle.db.$client.prepare(statement);
    if (prepared.reader) return prepared.all(...values) as T[];
    prepared.run(...values);
    return [];
  } finally {
    handle.close();
  }
}

/** Routes deployment jobs through a real DeploymentService whose only provider is the `trigger` mock. */
export function mockDeploymentSend(h: TestHarness, trigger: Mock) {
  const provider = {
    type: 'generic-webhook' as const,
    validateConfiguration: (v: unknown) => v as { url: string },
    validateDestination: async () => {},
    trigger,
  };
  const service = new DeploymentService(
    h.container.repos,
    h.container.credentials,
    new Map([['generic-webhook', provider]]),
    h.container.jobs,
    h.container.audit,
    h.clock,
    randomUUID,
  );
  vi.spyOn(h.container.deployments, 'execute').mockImplementation((job, ctx) => service.execute(job, ctx));
}
