import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ValidationError } from '@/server/domain/errors';
import {
  assertAllowedHost,
  classifyAddress,
  embeddedIpv4,
  embeddedIpv4Candidates,
} from '@/server/security/network-policy';
import { PathEscapeError, resolveRealWithin, resolveWithin } from '@/server/security/paths';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-paths-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('resolveWithin', () => {
  it('resolves relative paths inside the root', () => {
    expect(resolveWithin(root, 'repos/abc')).toBe(path.join(root, 'repos/abc'));
  });

  it.each(['../etc', 'repos/../../etc', '/etc/passwd', 'repos/..', '..\\x', 'a\0b', '', 'C:\\x'])(
    'blocks %j',
    (rel) => {
      expect(() => resolveWithin(root, rel)).toThrow(PathEscapeError);
    },
  );

  it('blocks symlink escapes', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-outside-'));
    fs.mkdirSync(path.join(root, 'repos'), { recursive: true });
    fs.symlinkSync(outside, path.join(root, 'repos', 'evil'));
    expect(() => resolveRealWithin(root, 'repos/evil')).toThrow(PathEscapeError);
    expect(() => resolveRealWithin(root, 'repos/evil/sub')).toThrow(PathEscapeError);
    expect(resolveRealWithin(root, 'repos/fine')).toBe(path.join(fs.realpathSync(root), 'repos/fine'));
    fs.rmSync(outside, { recursive: true, force: true });
  });
});

describe('network policy', () => {
  it.each([
    ['127.0.0.1', 'forbidden'],
    ['0.0.0.0', 'forbidden'],
    ['169.254.169.254', 'forbidden'],
    ['::1', 'forbidden'],
    ['fe80::1', 'forbidden'],
    ['::ffff:127.0.0.1', 'forbidden'],
    ['10.0.0.5', 'private'],
    ['172.20.1.1', 'private'],
    ['192.168.1.10', 'private'],
    ['100.64.0.1', 'private'],
    ['fd00::1', 'private'],
    ['140.82.112.3', 'public'],
    ['2606:4700::1', 'public'],
    // IPv4 embedded in IPv6: dotted and hexadecimal spellings, compatible/translated and NAT64 forms.
    ['::ffff:7f00:1', 'forbidden'],
    ['0:0:0:0:0:ffff:7f00:0001', 'forbidden'],
    ['::ffff:a9fe:a9fe', 'forbidden'],
    ['::ffff:169.254.169.254', 'forbidden'],
    ['::ffff:0:7f00:1', 'forbidden'],
    ['::7f00:1', 'forbidden'],
    ['64:ff9b::7f00:1', 'forbidden'],
    ['64:ff9b::a9fe:a9fe', 'forbidden'],
    ['64:ff9b:1::7f00:1', 'forbidden'],
    // RFC 6052 /48 layout inside the NAT64 local-use prefix: IPv4 split around the u octet.
    ['64:ff9b:1:7f00:1:100:8c52:7003', 'forbidden'],
    ['64:ff9b:1:a9fe:a9:fe00::', 'forbidden'],
    ['64:ff9b:1:c0a8:1:a00::', 'private'],
    ['64:ff9b:1:8c52:70:300::', 'public'],
    ['::ffff:c0a8:10a', 'private'],
    ['::ffff:10.1.2.3', 'private'],
    ['64:ff9b::a00:1', 'private'],
    ['::ffff:8c52:7003', 'public'],
    ['64:ff9b::8c52:7003', 'public'],
  ])('classifies %s as %s', (ip, cls) => expect(classifyAddress(ip)).toBe(cls));

  it('extracts embedded IPv4 only from IPv4-embedding prefixes', () => {
    expect(embeddedIpv4('::ffff:7f00:1')).toBe('127.0.0.1');
    expect(embeddedIpv4('64:ff9b::c0a8:101')).toBe('192.168.1.1');
    // 64:ff9b:1::/48 uses the RFC 6052 /48 layout: octets 1-2 in bits 48-63, u octet, octets 3-4 in bits 72-87.
    expect(embeddedIpv4('64:ff9b:1:7f00:1:100:8c52:7003')).toBe('127.0.1.1');
    expect(embeddedIpv4('64:ff9b:1:c0a8:1:a00::')).toBe('192.168.1.10');
    expect(embeddedIpv4('64:ff9b:1:8c52:70:300::')).toBe('140.82.112.3');
    // Every layout that fits the local-use prefix is considered (/48, /56, /64, /96).
    expect(embeddedIpv4Candidates('64:ff9b:1:7f00:1:100:8c52:7003')).toEqual(
      expect.arrayContaining(['127.0.1.1', '140.82.112.3']),
    );
    expect(embeddedIpv4Candidates('::ffff:7f00:1')).toEqual(['127.0.0.1']);
    expect(embeddedIpv4Candidates('64:ff9b:1::')).toEqual(['0.0.0.0']);
    expect(classifyAddress('64:ff9b:1::')).toBe('forbidden');
    expect(embeddedIpv4('2606:4700::6810:84e5')).toBeNull();
    expect(embeddedIpv4('::1')).toBeNull();
  });

  it('rejects mapped loopback/link-local hosts even when private networks are allowed', async () => {
    for (const host of [
      '[::ffff:7f00:1]',
      '::ffff:127.0.0.1',
      '[::ffff:a9fe:a9fe]',
      '[64:ff9b:1:7f00:1:100:8c52:7003]',
    ]) {
      await expect(assertAllowedHost(host, { allowPrivateNetworks: true })).rejects.toThrow(ValidationError);
    }
    await expect(
      assertAllowedHost('sneaky.example', {
        allowPrivateNetworks: true,
        resolver: async () => ['64:ff9b::7f00:1'],
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('blocks loopback/metadata always and private ranges unless allowed', async () => {
    const opts = (addrs: string[], allowPrivateNetworks = false) => ({
      allowPrivateNetworks,
      resolver: async () => addrs,
    });
    await expect(assertAllowedHost('localhost', opts(['127.0.0.1'], true))).rejects.toThrow(ValidationError);
    await expect(assertAllowedHost('169.254.169.254', opts([], true))).rejects.toThrow(ValidationError);
    await expect(assertAllowedHost('sneaky.example', opts(['127.0.0.1'], true))).rejects.toThrow(
      ValidationError,
    );
    await expect(assertAllowedHost('gitea.lan', opts(['192.168.1.20']))).rejects.toMatchObject({
      fields: { remoteUrl: expect.stringMatching(/PRIVATE_NETWORKS/) },
    });
    await expect(assertAllowedHost('gitea.lan', opts(['192.168.1.20'], true))).resolves.toBeUndefined();
    await expect(assertAllowedHost('github.com', opts(['140.82.112.3']))).resolves.toBeUndefined();
    await expect(
      assertAllowedHost('nx.example', {
        allowPrivateNetworks: false,
        resolver: async () => Promise.reject(new Error('ENOTFOUND')),
      }),
    ).rejects.toThrow(ValidationError);
  });
});
