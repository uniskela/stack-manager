import type { AppConfig } from '@/server/config/config';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isMutation(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase());
}

/**
 * CSRF defence for state-changing requests (on top of SameSite=Lax cookies and JSON-only bodies):
 * the Origin header (or Referer as a fallback) must match the app's own origin. The expected origin is
 * STACK_MANAGER_PUBLIC_URL when configured (recommended behind a reverse proxy), otherwise the Host header.
 */
export function isSameOrigin(req: Request, config: Pick<AppConfig, 'publicUrl'>): boolean {
  const origin = req.headers.get('origin') ?? refererOrigin(req.headers.get('referer'));
  if (!origin || origin === 'null') return false;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (config.publicUrl) return parsed.origin === config.publicUrl.origin;
  const host = req.headers.get('host');
  return host !== null && parsed.host === host;
}

function refererOrigin(referer: string | null): string | null {
  if (!referer) return null;
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}
