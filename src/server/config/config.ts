import path from 'node:path';
import { z } from 'zod';

/**
 * Application configuration, parsed once from the environment.
 *
 * Fails closed: a missing or malformed encryption key, session secret or data directory
 * is a fatal startup error. Error messages name the variable but never echo its value.
 */
export interface AppConfig {
  dataDir: string;
  databasePath: string;
  reposDir: string;
  encryption: { key: Buffer; keyVersion: number };
  sessionSecret: Buffer;
  sessionTtlMs: number;
  cookieSecure: boolean;
  publicUrl: URL | null;
  setupToken: string | null;
  allowPrivateNetworks: boolean;
  /** Number of trusted reverse proxies in front of the app; 0 = ignore X-Forwarded-For/X-Real-IP. */
  trustedProxyHops: number;
  logLevel: LogLevel;
  workerEnabled: boolean;
  gitAuthor: { name: string; email: string } | null;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const KNOWN_PLACEHOLDERS = new Set(['change-me', 'changeme', 'replace-me', 'example']);

const bool = (name: string) =>
  z
    .enum(['true', 'false', '1', '0', 'yes', 'no'], {
      error: `${name} must be one of true/false/1/0/yes/no`,
    })
    .transform((v) => v === 'true' || v === '1' || v === 'yes');

function decodeEncryptionKey(raw: string | undefined): Buffer {
  if (!raw || raw.trim() === '') {
    throw new ConfigError(
      'STACK_MANAGER_ENCRYPTION_KEY is required (32 random bytes, base64). Generate one with: openssl rand -base64 32',
    );
  }
  const trimmed = raw.trim();
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(trimmed)) {
    throw new ConfigError('STACK_MANAGER_ENCRYPTION_KEY must be base64 encoded.');
  }
  const key = Buffer.from(trimmed.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (key.length !== 32) {
    throw new ConfigError('STACK_MANAGER_ENCRYPTION_KEY must decode to exactly 32 bytes (AES-256).');
  }
  if (key.every((b) => b === key[0])) {
    throw new ConfigError('STACK_MANAGER_ENCRYPTION_KEY looks like a placeholder; use a random key.');
  }
  return key;
}

function decodeSessionSecret(raw: string | undefined): Buffer {
  if (!raw || raw.trim() === '') {
    throw new ConfigError(
      'STACK_MANAGER_SESSION_SECRET is required (at least 32 characters). Generate one with: openssl rand -base64 48',
    );
  }
  const trimmed = raw.trim();
  if (trimmed.length < 32 || KNOWN_PLACEHOLDERS.has(trimmed.toLowerCase())) {
    throw new ConfigError('STACK_MANAGER_SESSION_SECRET must be at least 32 random characters.');
  }
  return Buffer.from(trimmed, 'utf8');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const dataDirRaw = env.STACK_MANAGER_DATA_DIR?.trim();
  if (!dataDirRaw) {
    throw new ConfigError('STACK_MANAGER_DATA_DIR is required (persistent directory for SQLite and clones).');
  }
  const dataDir = path.resolve(dataDirRaw);

  const key = decodeEncryptionKey(env.STACK_MANAGER_ENCRYPTION_KEY);
  const sessionSecret = decodeSessionSecret(env.STACK_MANAGER_SESSION_SECRET);
  if (sessionSecret.equals(Buffer.from(env.STACK_MANAGER_ENCRYPTION_KEY?.trim() ?? '', 'utf8'))) {
    throw new ConfigError('STACK_MANAGER_SESSION_SECRET must differ from STACK_MANAGER_ENCRYPTION_KEY.');
  }

  const optional = z.object({
    STACK_MANAGER_ENCRYPTION_KEY_VERSION: z.coerce
      .number()
      .int()
      .min(1, 'STACK_MANAGER_ENCRYPTION_KEY_VERSION must be a positive integer')
      .default(1),
    STACK_MANAGER_PUBLIC_URL: z
      .url({ error: 'STACK_MANAGER_PUBLIC_URL must be an absolute URL' })
      .optional()
      .or(z.literal('').transform(() => undefined)),
    STACK_MANAGER_COOKIE_SECURE: bool('STACK_MANAGER_COOKIE_SECURE').optional(),
    STACK_MANAGER_SETUP_TOKEN: z.string().optional(),
    STACK_MANAGER_ALLOW_PRIVATE_NETWORKS: bool('STACK_MANAGER_ALLOW_PRIVATE_NETWORKS').default(false),
    STACK_MANAGER_TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
    STACK_MANAGER_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    STACK_MANAGER_WORKER_ENABLED: bool('STACK_MANAGER_WORKER_ENABLED').default(true),
    STACK_MANAGER_SESSION_TTL_HOURS: z.coerce
      .number()
      .int()
      .min(1)
      .max(24 * 90)
      .default(24 * 7),
  });
  const parsed = optional.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  const o = parsed.data;

  const publicUrl = o.STACK_MANAGER_PUBLIC_URL ? new URL(o.STACK_MANAGER_PUBLIC_URL) : null;
  if (publicUrl && publicUrl.protocol !== 'https:' && publicUrl.protocol !== 'http:') {
    throw new ConfigError('STACK_MANAGER_PUBLIC_URL must use http or https.');
  }
  const setupToken = o.STACK_MANAGER_SETUP_TOKEN?.trim() || null;
  if (setupToken && setupToken.length < 16) {
    throw new ConfigError('STACK_MANAGER_SETUP_TOKEN must be at least 16 characters when set.');
  }

  const name = env.STACK_MANAGER_GIT_AUTHOR_NAME?.trim() || '';
  const email = env.STACK_MANAGER_GIT_AUTHOR_EMAIL?.trim() || '';
  if (
    (name || email) &&
    (!name ||
      !email ||
      /[\u0000-\u001f\u007f<>]/.test(name + email) ||
      name.length > 200 ||
      email.length > 254 ||
      !z.email().safeParse(email).success)
  ) {
    throw new ConfigError(
      'Set STACK_MANAGER_GIT_AUTHOR_NAME and STACK_MANAGER_GIT_AUTHOR_EMAIL to a printable name and valid email.',
    );
  }

  return {
    dataDir,
    databasePath: path.join(dataDir, 'stack-manager.sqlite'),
    reposDir: path.join(dataDir, 'repos'),
    encryption: { key, keyVersion: o.STACK_MANAGER_ENCRYPTION_KEY_VERSION },
    sessionSecret,
    sessionTtlMs: o.STACK_MANAGER_SESSION_TTL_HOURS * 60 * 60 * 1000,
    cookieSecure: o.STACK_MANAGER_COOKIE_SECURE ?? env.NODE_ENV === 'production',
    publicUrl,
    setupToken,
    allowPrivateNetworks: o.STACK_MANAGER_ALLOW_PRIVATE_NETWORKS,
    trustedProxyHops: o.STACK_MANAGER_TRUSTED_PROXY_HOPS,
    logLevel: o.STACK_MANAGER_LOG_LEVEL,
    workerEnabled: o.STACK_MANAGER_WORKER_ENABLED,
    gitAuthor: name && email ? { name, email } : null,
  };
}
