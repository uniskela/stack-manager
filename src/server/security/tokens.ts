import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Opaque, high-entropy token for session cookies. Only its keyed hash is persisted. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * HMAC-SHA256(sessionSecret, token). The database stores this digest, so a leaked DB or backup
 * cannot be replayed as a cookie without STACK_MANAGER_SESSION_SECRET.
 */
export function hashSessionToken(token: string, secret: Buffer): string {
  return createHmac('sha256', secret).update(token, 'utf8').digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
