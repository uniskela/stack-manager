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

/** Expands an IPv6 address (any textual form, incl. dotted IPv4 tail) into eight 16-bit groups. */
function ipv6Groups(ip: string): number[] | null {
  let text = ip.toLowerCase();
  const dotted = text.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string) => (part ? part.split(':').map((g) => parseInt(g, 16)) : []);
  const head = parse(halves[0] ?? '');
  const tail = halves.length === 2 ? parse(halves[1] ?? '') : [];
  const groups =
    halves.length === 2 ? [...head, ...Array(8 - head.length - tail.length).fill(0), ...tail] : head;
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff)
    ? groups
    : null;
}

/**
 * IPv4 address embedded in an IPv6 address that routes to IPv4 space: IPv4-mapped (::ffff:0:0/96),
 * IPv4-compatible (::/96, deprecated), IPv4-translated (::ffff:0:0:0/96) and NAT64 well-known /
 * local-use prefixes (64:ff9b::/96, 64:ff9b:1::/48 with the RFC 6052 /96 layout). Handles both the
 * dotted (::ffff:127.0.0.1) and hexadecimal (::ffff:7f00:1) spellings.
 */
export function embeddedIpv4(address: string): string | null {
  const g = ipv6Groups(address);
  if (!g) return null;
  const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  const mapped = zero(0, 5) && g[5] === 0xffff;
  const compatible = zero(0, 6) && (g[6] !== 0 || (g[7] ?? 0) > 1);
  const translated = zero(0, 4) && g[4] === 0xffff && g[5] === 0;
  const nat64 = g[0] === 0x64 && g[1] === 0xff9b && (zero(2, 6) || g[2] === 1);
  if (!mapped && !compatible && !translated && !nat64) return null;
  const hi = g[6]!;
  const lo = g[7]!;
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

export function classifyAddress(address: string): AddressClass {
  const family = net.isIP(address);
  if (family === 4) return ipv4Class(address);
  if (family !== 6) return 'forbidden';
  const ip = address.toLowerCase();
  const v4 = embeddedIpv4(ip);
  if (v4) return ipv4Class(v4);
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
