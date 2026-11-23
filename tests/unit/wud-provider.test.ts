import { describe, expect, it } from 'vitest';
import { normalizeWudObservations, WudClient, wudBaseUrl } from '@/server/providers/wud/client';

const sample = {
  id: 'fixture-id',
  watcher: 'local',
  labels: {
    'com.docker.compose.project': 'wiki',
    'com.docker.compose.service': 'web',
    'arbitrary.label': 'discard-this-value',
  },
  image: { registry: { url: 'https://registry-1.docker.io' }, name: 'library/nginx', tag: { value: '1.26' } },
  checkedAt: '2026-11-23T07:00:00Z',
  updateAvailable: true,
  result: { tag: '1.27' },
};

describe('WUD response handling', () => {
  it('retains only normalized fields needed to compare a Compose service', () => {
    expect(normalizeWudObservations([sample, { ...sample, labels: {} }])).toEqual([
      {
        watcher: 'local',
        project: 'wiki',
        service: 'web',
        repository: 'index.docker.io/library/nginx',
        installedTag: '1.26',
        installedDigest: null,
        checkedAt: '2026-11-23T07:00:00.000Z',
        available: true,
        candidateTag: '1.27',
        digestOnly: false,
        failed: false,
      },
    ]);
  });

  it('rejects a single object in place of a snapshot', () => {
    expect(() => normalizeWudObservations(sample)).toThrow('invalid');
  });

  it('removes trailing slashes from a WUD URL while preserving its prefix', () => {
    expect(wudBaseUrl('https://wud.example')).toBe('https://wud.example');
    expect(wudBaseUrl('https://wud.example/proxy//wud%2F///')).toBe('https://wud.example/proxy//wud%2F');
  });

  it('permits a private HTTPS endpoint only under explicit network policy', async () => {
    const resolver = async () => ['192.168.11.22'];
    await expect(
      new WudClient({ allowPrivateNetworks: false, resolver }).read('https://wud.example', 'fixture-token'),
    ).rejects.toThrow('WUD');
  });

  it.each([
    'https://wud.example?token=no',
    'https://username@wud.example',
    'http://wud.example',
    'https://wud.example#fragment',
  ])('rejects an invalid WUD URL before resolving it', async (url) => {
    const client = new WudClient({
      allowPrivateNetworks: true,
      resolver: async () => {
        throw new Error('DNS should not be reached');
      },
    });
    await expect(client.read(url, 'fixture-token')).rejects.toThrow('HTTPS');
  });
});
