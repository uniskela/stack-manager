import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { ValidationError } from '@/server/domain/errors';

/**
 * Outbound host policy for credential-bearing requests (SSRF control, docs/SECURITY.md).
 *
 * Always denied: loopback, unspecified, link-local (incl. cloud metadata 169.254.169.254),
 * multicast/reserved. Private ranges (RFC 1918, CGNAT, IPv6 ULA) are denied unless the operator
 * sets STACK_MANAGER_ALLOW_PRIVATE_NETWORKS=true — typical for a homelab Gitea/Forgejo.
 */
export type AddressClass = 'public' | 'private' | 'forbidden';

function ipv4Class(ip: string): AddressClass {
  const [a = 0, b = 0] = ip.split('.').map(Number);
  if (a === 0 || a === 127 || (a === 169 && b === 254) || a >= 224) return 'forbidden';
  if (a === 100 && b >= 64 && b <= 127) return 'private'; // CGNAT / Tailscale
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'private';
  if (a === 198 && (b === 18 || b === 19)) return 'private';
  return 'public';
}

export function classifyAddress(address: string): AddressClass {
  const family = net.isIP(address);
  if (family === 4) return ipv4Class(address);
  if (family !== 6) return 'forbidden';
  const ip = address.toLowerCase();
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1]) return ipv4Class(mapped[1]);
  if (ip === '::' || ip === '::1') return 'forbidden';
  if (/^fe[89ab]/.test(ip)) return 'forbidden'; // link-local
  if (/^ff/.test(ip)) return 'forbidden'; // multicast
  if (/^f[cd]/.test(ip)) return 'private'; // unique local
  return 'public';
}

export type Resolver = (hostname: string) => Promise<string[]>;

const systemResolver: Resolver = async (hostname) =>
  (await lookup(hostname, { all: true })).map((r) => r.address);

export async function assertAllowedHost(
  hostname: string,
  options: { allowPrivateNetworks: boolean; resolver?: Resolver },
): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, '');
  const lower = host.toLowerCase();
  const reject = (msg: string): never => {
    throw new ValidationError('Remote host is not allowed.', { remoteUrl: msg });
  };
  if (lower === 'localhost' || lower.endsWith('.localhost')) reject('Loopback hosts are not allowed.');
  if (lower === 'metadata.google.internal') reject('Cloud metadata endpoints are not allowed.');

  let addresses: string[];
  if (net.isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = await (options.resolver ?? systemResolver)(host);
    } catch {
      return reject('Host name could not be resolved.');
    }
  }
  if (addresses.length === 0) reject('Host name could not be resolved.');
  for (const address of addresses) {
    const cls = classifyAddress(address);
    if (cls === 'forbidden') reject('Loopback, link-local and metadata addresses are not allowed.');
    if (cls === 'private' && !options.allowPrivateNetworks) {
      reject(
        'Private network address. Set STACK_MANAGER_ALLOW_PRIVATE_NETWORKS=true to allow homelab forges.',
      );
    }
  }
}
