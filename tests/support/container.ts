import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig } from '@/server/config/config';
import { createContainer, setContainer, type Container, type ContainerOverrides } from '@/server/container';
import { createLogger } from '@/server/observability/logger';
import { MutableClock } from './clock';
import { testConfig } from './config';

export interface TestHarness {
  container: Container;
  config: AppConfig;
  dataDir: string;
  clock: MutableClock;
  logs: string[];
  cleanup(): Promise<void>;
}

/** A fully wired container on a fresh temp data dir (real SQLite, real migrations, real crypto). */
export async function createHarness(
  options: {
    env?: Record<string, string>;
    overrides?: ContainerOverrides;
    config?: AppConfig;
    dataDir?: string;
  } = {},
): Promise<TestHarness> {
  const dataDir = options.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'stack-manager-test-'));
  const config = options.config ?? testConfig(dataDir, options.env);
  const clock = new MutableClock(Date.now());
  const logs: string[] = [];
  const logger = createLogger({ level: 'debug', sink: (line) => logs.push(line) });
  const container = createContainer(config, {
    clock,
    logger,
    migrationsFolder: path.join(process.cwd(), 'drizzle'),
    resolver: async () => ['203.0.113.10'],
    ...options.overrides,
  });
  setContainer(container);
  return {
    container,
    config,
    dataDir,
    clock,
    logs,
    cleanup: async () => {
      setContainer(undefined);
      await container.close();
      if (!options.dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
