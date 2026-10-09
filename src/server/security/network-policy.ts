import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { ValidationError } from '@/server/domain/errors';

/**
 * Outbound host policy for credential-bearing requests (SSRF control, docs/public/SECURITY.md).
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

/** Byte offsets of the four IPv4 octets for each RFC 6052 prefix length (octet 8, the `u` byte, is skipped). */
const RFC6052_LAYOUTS: Record<48 | 56 | 64 | 96, readonly number[]> = {
  48: [6, 7, 9, 10],
  56: [7, 9, 10, 11],
  64: [9, 10, 11, 12],
  96: [12, 13, 14, 15],
};

/**
 * Every IPv4 address an IPv6 address may embed, for the IPv4-embedding forms we recognise:
 *
 * - IPv4-mapped `::ffff:0:0/96`, IPv4-compatible `::/96` (deprecated), IPv4-translated `::ffff:0:0:0/96`;
 * - NAT64 well-known prefix `64:ff9b::/96` (RFC 6052: only used with /96);
 * - NAT64 local-use prefix `64:ff9b:1::/48` (RFC 8215). Operators may carve any RFC 6052 prefix length
 *   from /48 to /96 out of it, and the address alone does not reveal which, so all layouts that fit
 *   (/48, /56, /64, /96) are returned and callers must apply the most restrictive result. This fails
 *   closed: an unusual local-use address may be over-restricted, never under-restricted.
 *
 * Both dotted (`::ffff:127.0.0.1`) and hexadecimal (`::ffff:7f00:1`) spellings are handled.
 */
export function embeddedIpv4Candidates(address: string): string[] {
  const g = ipv6Groups(address);
  if (!g) return [];
  const bytes = g.flatMap((x) => [x >> 8, x & 0xff]);
  const at = (layout: readonly number[]) => layout.map((i) => bytes[i]).join('.');
  const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);

  const mapped = zero(0, 5) && g[5] === 0xffff;
  const compatible = zero(0, 6) && (g[6] !== 0 || (g[7] ?? 0) > 1);
  const translated = zero(0, 4) && g[4] === 0xffff && g[5] === 0;
  const nat64WellKnown = g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6);
  if (mapped || compatible || translated || nat64WellKnown) return [at(RFC6052_LAYOUTS[96])];

  const nat64LocalUse = g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1;
  if (nat64LocalUse) {
    const candidates = [...new Set([48, 56, 64, 96].map((len) => at(RFC6052_LAYOUTS[len as 48])))];
    // A layout whose bits are all zero is simply not in use (RFC 6052 zeroes the suffix), not an embedded
    // 0.0.0.0 — unless every layout is zero, which does embed 0.0.0.0.
    const nonZero = candidates.filter((c) => c !== '0.0.0.0');
    return nonZero.length > 0 ? nonZero : ['0.0.0.0'];
  }
  return [];
}

/** Primary embedded IPv4 (the /48 layout for the NAT64 local-use prefix), or null. */
export function embeddedIpv4(address: string): string | null {
  return embeddedIpv4Candidates(address)[0] ?? null;
}

const SEVERITY: Record<AddressClass, number> = { public: 0, private: 1, forbidden: 2 };

export function classifyAddress(address: string): AddressClass {
  const family = net.isIP(address);
  if (family === 4) return ipv4Class(address);
  if (family !== 6) return 'forbidden';
  const ip = address.toLowerCase();
  const embedded = embeddedIpv4Candidates(ip).map(ipv4Class);
  if (embedded.length > 0) return embedded.reduce((worst, c) => (SEVERITY[c] > SEVERITY[worst] ? c : worst));
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
