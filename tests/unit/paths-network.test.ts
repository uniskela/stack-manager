import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ValidationError } from '@/server/domain/errors';
import { assertAllowedHost, classifyAddress } from '@/server/security/network-policy';
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
  ])('classifies %s as %s', (ip, cls) => expect(classifyAddress(ip)).toBe(cls));

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
