import { hash, verify, type Algorithm } from '@node-rs/argon2';

/**
 * Argon2id password hashing (docs/AUTH_AND_CREDENTIALS.md).
 * Parameters exceed the OWASP minimum (m=19 MiB, t=2, p=1); a single-operator instance can afford it.
 */
const PARAMS = {
  algorithm: 2 as Algorithm, // Algorithm.Argon2id (const enum; not importable under isolatedModules)
  memoryCost: 64 * 1024, // KiB
  timeCost: 3,
  parallelism: 1,
  outputLen: 32,
} as const;

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

export async function hashPassword(password: string): Promise<string> {
  return hash(password, PARAMS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | null = null;

/** Burns comparable time when a username does not exist, to blunt user enumeration by timing. */
export async function verifyAgainstDummy(password: string): Promise<false> {
  dummyHash ??= hash('stack-manager-dummy-password', PARAMS);
  await verifyPassword(await dummyHash, password);
  return false;
}
