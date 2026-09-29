import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { loadConfig, type AppConfig } from '@/server/config/config';

export function testEnv(dataDir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    STACK_MANAGER_DATA_DIR: dataDir,
    STACK_MANAGER_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    STACK_MANAGER_SESSION_SECRET: randomBytes(48).toString('base64'),
    STACK_MANAGER_LOG_LEVEL: 'debug',
    ...extra,
  } as NodeJS.ProcessEnv;
}

export function testConfig(dataDir: string, extra: Record<string, string> = {}): AppConfig {
  return loadConfig(testEnv(path.resolve(dataDir), extra));
}
