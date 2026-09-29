import type { AppConfig } from '@/server/config/config';

/**
 * With Secure cookies we use the `__Host-` prefix: browsers then require Secure, Path=/ and no
 * Domain attribute, which blocks subdomain cookie injection.
 */
export function sessionCookieName(config: Pick<AppConfig, 'cookieSecure'>): string {
  return config.cookieSecure ? '__Host-sm_session' : 'sm_session';
}

export function parseCookies(header: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!out.has(name)) {
      try {
        out.set(name, decodeURIComponent(value));
      } catch {
        out.set(name, value);
      }
    }
  }
  return out;
}

export function serializeSessionCookie(
  config: Pick<AppConfig, 'cookieSecure'>,
  token: string,
  expiresAt: Date,
): string {
  const attrs = [
    `${sessionCookieName(config)}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Expires=${expiresAt.toUTCString()}`,
  ];
  if (config.cookieSecure) attrs.push('Secure');
  return attrs.join('; ');
}

export function clearSessionCookie(config: Pick<AppConfig, 'cookieSecure'>): string {
  const attrs = [`${sessionCookieName(config)}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (config.cookieSecure) attrs.push('Secure');
  return attrs.join('; ');
}
