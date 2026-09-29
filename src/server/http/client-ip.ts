import net from 'node:net';

/**
 * Client address used only as a rate-limit key.
 *
 * Next.js route handlers receive a Web `Request` without the socket address, so the only source is
 * forwarding headers — which any client can forge. They are therefore ignored unless the operator
 * declares how many trusted reverse proxies sit in front of the app (STACK_MANAGER_TRUSTED_PROXY_HOPS).
 * With N trusted hops, each proxy appends the address it received the connection from, so the client
 * is the N-th entry from the right of X-Forwarded-For; entries further left are client-controlled.
 * Returns null when the address cannot be determined; callers must not pool unknown clients together.
 */
export function clientIpFrom(headers: Headers, trustedProxyHops: number): string | null {
  if (trustedProxyHops <= 0) return null;
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) {
    const chain = forwarded
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    const candidate = chain[chain.length - trustedProxyHops];
    return candidate ? normalizeIp(candidate) : null;
  }
  // A single trusted proxy may set X-Real-IP instead of X-Forwarded-For.
  const realIp = trustedProxyHops === 1 ? headers.get('x-real-ip')?.trim() : undefined;
  return realIp ? normalizeIp(realIp) : null;
}

function normalizeIp(value: string): string | null {
  const bracketed = value.match(/^\[([^\]]+)\](?::\d+)?$/);
  const withoutPort =
    bracketed?.[1] ?? (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(value) ? value.split(':')[0]! : value);
  return net.isIP(withoutPort) ? withoutPort.toLowerCase() : null;
}
