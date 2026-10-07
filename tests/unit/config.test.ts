import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '@/server/config/config';

const key = randomBytes(32).toString('base64');
const secret = randomBytes(48).toString('base64');
const base = {
  STACK_MANAGER_DATA_DIR: '/tmp/sm',
  STACK_MANAGER_ENCRYPTION_KEY: key,
  STACK_MANAGER_SESSION_SECRET: secret,
};
const env = (over: Record<string, string | undefined>) =>
  ({ ...base, ...over }) as unknown as NodeJS.ProcessEnv;

describe('loadConfig (fail closed)', () => {
  it('accepts a valid configuration', () => {
    const cfg = loadConfig(env({}));
    expect(cfg.encryption.key).toHaveLength(32);
    expect(cfg.encryption.keyVersion).toBe(1);
    expect(cfg.databasePath).toBe('/tmp/sm/stack-manager.sqlite');
    expect(cfg.reposDir).toBe('/tmp/sm/repos');
    expect(cfg.allowPrivateNetworks).toBe(false);
    expect(cfg.gitAuthor).toBeNull();
  });

  it('resolves a configured Git identity', () => {
    expect(
      loadConfig(
        env({
          STACK_MANAGER_GIT_AUTHOR_NAME: ' Operator ',
          STACK_MANAGER_GIT_AUTHOR_EMAIL: ' operator@example.invalid ',
        }),
      ).gitAuthor,
    ).toEqual({ name: 'Operator', email: 'operator@example.invalid' });
  });

  it.each([
    { STACK_MANAGER_GIT_AUTHOR_NAME: 'Operator' },
    { STACK_MANAGER_GIT_AUTHOR_EMAIL: 'operator@example.invalid' },
    {
      STACK_MANAGER_GIT_AUTHOR_NAME: 'Bad\nName',
      STACK_MANAGER_GIT_AUTHOR_EMAIL: 'operator@example.invalid',
    },
    { STACK_MANAGER_GIT_AUTHOR_NAME: 'Operator', STACK_MANAGER_GIT_AUTHOR_EMAIL: 'invalid-value' },
  ])('rejects malformed or incomplete Git identity without echoing values', (over) => {
    expect(() => loadConfig(env(over))).toThrow(ConfigError);
    expect(() => loadConfig(env(over))).not.toThrow('invalid-value');
  });

  it.each([
    ['missing data dir', { STACK_MANAGER_DATA_DIR: undefined }],
    ['missing key', { STACK_MANAGER_ENCRYPTION_KEY: undefined }],
    ['non-base64 key', { STACK_MANAGER_ENCRYPTION_KEY: 'not base64!!' }],
    ['short key', { STACK_MANAGER_ENCRYPTION_KEY: randomBytes(16).toString('base64') }],
    ['placeholder key', { STACK_MANAGER_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64') }],
    ['missing session secret', { STACK_MANAGER_SESSION_SECRET: undefined }],
    ['short session secret', { STACK_MANAGER_SESSION_SECRET: 'too-short' }],
    ['session secret equal to key', { STACK_MANAGER_SESSION_SECRET: key }],
    ['bad boolean', { STACK_MANAGER_COOKIE_SECURE: 'maybe' }],
    ['short setup token', { STACK_MANAGER_SETUP_TOKEN: 'abc' }],
  ])('rejects %s', (_name, over) => {
    expect(() => loadConfig(env(over))).toThrow(ConfigError);
  });

  it('never echoes secret values in errors', () => {
    const bad = randomBytes(16).toString('base64');
    try {
      loadConfig(env({ STACK_MANAGER_ENCRYPTION_KEY: bad }));
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain(bad);
    }
  });

  it('defaults Secure cookies on in production', () => {
    expect(loadConfig(env({ NODE_ENV: 'production' })).cookieSecure).toBe(true);
    expect(
      loadConfig(env({ NODE_ENV: 'production', STACK_MANAGER_COOKIE_SECURE: 'false' })).cookieSecure,
    ).toBe(false);
    expect(loadConfig(env({ NODE_ENV: 'development' })).cookieSecure).toBe(false);
  });
});
