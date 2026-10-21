import https, { type RequestOptions } from 'node:https';
import net, { type LookupFunction } from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDeploymentProviders, GENERIC_DEPLOYMENT_BODY } from '@/server/providers/deployment/registry';
import { ValidationError } from '@/server/domain/errors';

const publicAddress = '93.184.216.34';
const endpoint = 'https://webhook.example/api/stacks/webhooks/secret-token';
const provider = (allowPrivateNetworks = false, resolver = async () => [publicAddress]) =>
  createDeploymentProviders({ allowPrivateNetworks, resolver });

describe('deployment configuration and destination policy', () => {
  it('validates strict configuration without echoing secret input', () => {
    const p = provider().get('generic-webhook')!;
    expect(p.validateConfiguration({ url: endpoint, bearerToken: 'secret' })).toEqual({
      url: endpoint,
      bearerToken: 'secret',
    });
    for (const input of [
      { url: 'http://webhook.example/secret' },
      { url: 'https://user:secret@webhook.example/' },
      { url: `${endpoint}#secret` },
      { url: 'https://webhook.example/\nsecret' },
      { url: 'secret' },
      { url: endpoint, headers: { Authorization: 'secret' } },
      { url: endpoint, bearerToken: 'secret\r\ninjected' },
      { url: endpoint, bearerToken: '' },
    ]) {
      expect(() => p.validateConfiguration(input)).toThrow(ValidationError);
      try {
        p.validateConfiguration(input);
      } catch (error) {
        expect(String(error)).not.toContain('secret');
      }
    }
    expect(() =>
      provider().get('portainer-webhook')!.validateConfiguration({ url: endpoint, bearerToken: 'secret' }),
    ).toThrow(ValidationError);
  });

  it('blocks loopback, link-local, metadata and mapped addresses even with private opt-in', async () => {
    const p = provider(true).get('generic-webhook')!;
    for (const host of [
      '127.0.0.1',
      '[::1]',
      'localhost',
      '169.254.169.254',
      'metadata.google.internal',
      '[::ffff:127.0.0.1]',
      '[64:ff9b::a9fe:a9fe]',
    ]) {
      await expect(p.validateDestination({ url: `https://${host}/secret` })).rejects.toThrow(ValidationError);
    }
    await expect(
      provider(true, async () => [publicAddress, '127.0.0.1'])
        .get('generic-webhook')!
        .validateDestination({ url: endpoint }),
    ).rejects.toThrow(ValidationError);
  });

  it('requires explicit permission for private homelab reverse proxies', async () => {
    for (const address of ['10.0.0.2', '192.168.1.10', '100.95.209.36', 'fd00::2']) {
      await expect(
        provider(false, async () => [address])
          .get('portainer-webhook')!
          .validateDestination({ url: endpoint }),
      ).rejects.toThrow(ValidationError);
      await expect(
        provider(true, async () => [address])
          .get('portainer-webhook')!
          .validateDestination({ url: endpoint }),
      ).resolves.toBeUndefined();
    }
  });

  it('bounds DNS validation and trigger execution even if resolution never completes', async () => {
    const p = createDeploymentProviders({
      allowPrivateNetworks: false,
      resolver: () => new Promise(() => {}),
      totalTimeoutMs: 30,
    }).get('generic-webhook')!;
    await expect(p.validateDestination({ url: endpoint })).rejects.toThrow('timed out');
    await expect(p.trigger({ url: endpoint }, {})).resolves.toEqual({ status: 'rejected', httpStatus: null });
  });
});

describe('local HTTPS webhook transport', () => {
  let directory: string;
  let certificate: Buffer;
  let server: https.Server;
  let port: number;
  let status = 204;
  let stall = false;
  let calls: Array<{ method?: string; body: string; headers: Record<string, unknown> }> = [];
  const originalRequest = https.request;

  async function cleanup() {
    try {
      if (server) {
        server.closeAllConnections();
        if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    } finally {
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  }

  beforeAll(async () => {
    try {
      directory = mkdtempSync(path.join(tmpdir(), 'deployment-tls-'));
      const key = path.join(directory, 'key.pem');
      const cert = path.join(directory, 'cert.pem');
      execFileSync(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-keyout',
          key,
          '-out',
          cert,
          '-days',
          '1',
          '-subj',
          '/CN=webhook.example',
          '-addext',
          'subjectAltName=DNS:webhook.example',
        ],
        { stdio: 'ignore' },
      );
      certificate = readFileSync(cert);
      server = https.createServer({ key: readFileSync(key), cert: certificate }, (request, response) => {
        let body = '';
        request.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        request.on('end', () => {
          calls.push({ method: request.method, body, headers: request.headers });
          if (stall) return;
          response.writeHead(status, { Location: `https://other.example:${port}/stolen` });
          response.end('provider-response-secret');
        });
      });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      port = (server.address() as { port: number }).port;
    } catch (error) {
      await cleanup();
      throw error;
    }
  });
  afterAll(cleanup);
  afterEach(() => {
    vi.restoreAllMocks();
    calls = [];
    status = 204;
    stall = false;
  });

  function mockLocalConnection(trustCertificate = true) {
    // Test-only routing to loopback: production request options still contain the validated pin.
    return vi.spyOn(https, 'request').mockImplementation(((
      url: URL,
      options: RequestOptions,
      callback: (response: import('node:http').IncomingMessage) => void,
    ) => {
      const lookup: LookupFunction = (_hostname, options, done) => {
        if (options.all) done(null, [{ address: '127.0.0.1', family: 4 }]);
        else done(null, '127.0.0.1', 4);
      };
      return originalRequest(
        url,
        { ...options, port, lookup, ...(trustCertificate ? { ca: certificate } : {}) },
        callback,
      );
    }) as typeof https.request);
  }

  it('sends generic fixed JSON and bearer only to the validated hostname, preserving TLS verification', async () => {
    const request = mockLocalConnection();
    const resolver = vi.fn(async () => [publicAddress]);
    const result = await provider(false, resolver)
      .get('generic-webhook')!
      .trigger({ url: endpoint, bearerToken: 'private-bearer' }, { idempotencyKey: 'attempt-123' });
    expect(result).toEqual({ status: 'accepted', httpStatus: 204 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      body: GENERIC_DEPLOYMENT_BODY,
      headers: {
        authorization: 'Bearer private-bearer',
        'content-type': 'application/json',
        'idempotency-key': 'attempt-123',
      },
    });
    expect((request.mock.calls[0]![0] as URL).hostname).toBe('webhook.example');
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it('pins the validated DNS snapshot and never consults a rebinding resolver twice', async () => {
    const request = mockLocalConnection();
    const resolver = vi.fn().mockResolvedValueOnce([publicAddress]).mockResolvedValue(['127.0.0.1']);
    await provider(false, resolver).get('portainer-webhook')!.trigger({ url: endpoint }, {});
    const options = request.mock.calls[0]![1] as RequestOptions;
    const lookup = options.lookup!;
    const callback = vi.fn();
    lookup('webhook.example', {}, callback);
    expect(callback).toHaveBeenCalledWith(null, publicAddress, 4);
    const allCallback = vi.fn();
    lookup('webhook.example', { all: true }, allCallback);
    expect(allCallback).toHaveBeenCalledWith(null, [{ address: publicAddress, family: 4 }]);
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(options.agent).toBe(false);
    expect(calls[0]).toMatchObject({ method: 'POST', body: '' });
    expect(calls[0]!.headers.authorization).toBeUndefined();
  });

  it('rejects redirects without forwarding credentials or reading provider error content', async () => {
    mockLocalConnection();
    status = 302;
    const result = await provider()
      .get('generic-webhook')!
      .trigger({ url: endpoint, bearerToken: 'private-bearer' }, {});
    expect(result).toEqual({ status: 'rejected', httpStatus: 302 });
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('reports an HTTP rejection without reading secret response content', async () => {
    mockLocalConnection();
    status = 403;
    expect(await provider().get('portainer-webhook')!.trigger({ url: endpoint }, {})).toEqual({
      status: 'rejected',
      httpStatus: 403,
    });
  });

  it('retains certificate validation for invalid TLS', async () => {
    mockLocalConnection(false);
    expect(await provider().get('generic-webhook')!.trigger({ url: endpoint }, {})).toEqual({
      status: 'unknown',
      reason: 'request_failed',
    });
    expect(calls).toHaveLength(0);
  });

  it('retains hostname verification even when a custom CA trusts the certificate', async () => {
    mockLocalConnection();
    expect(
      await provider()
        .get('generic-webhook')!
        .trigger({ url: endpoint.replace('webhook.example', 'wrong.example') }, {}),
    ).toEqual({ status: 'unknown', reason: 'request_failed' });
    expect(calls).toHaveLength(0);
  });

  it('treats a timeout after the POST as an unknown outcome with no retry', async () => {
    mockLocalConnection();
    stall = true;
    const p = createDeploymentProviders({
      allowPrivateNetworks: false,
      resolver: async () => [publicAddress],
      totalTimeoutMs: 100,
    }).get('generic-webhook')!;
    expect(await p.trigger({ url: endpoint }, {})).toEqual({
      status: 'unknown',
      reason: 'request_timeout_or_cancelled',
    });
    expect(calls).toHaveLength(1);
  });

  it('bounds the TLS handshake with the connection timeout', async () => {
    const blackhole = net.createServer();
    const sockets = new Set<import('node:net').Socket>();
    blackhole.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => blackhole.listen(0, '127.0.0.1', resolve));
    const blackholePort = (blackhole.address() as { port: number }).port;
    vi.spyOn(https, 'request').mockImplementation(((
      url: URL,
      options: RequestOptions,
      callback: (response: import('node:http').IncomingMessage) => void,
    ) => {
      const lookup: LookupFunction = (_hostname, lookupOptions, done) => {
        if (lookupOptions.all) done(null, [{ address: '127.0.0.1', family: 4 }]);
        else done(null, '127.0.0.1', 4);
      };
      return originalRequest(url, { ...options, port: blackholePort, lookup }, callback);
    }) as typeof https.request);
    try {
      const p = createDeploymentProviders({
        allowPrivateNetworks: false,
        resolver: async () => [publicAddress],
        connectTimeoutMs: 30,
        totalTimeoutMs: 5000,
      }).get('portainer-webhook')!;
      expect(await p.trigger({ url: endpoint }, {})).toEqual({ status: 'unknown', reason: 'request_failed' });
    } finally {
      sockets.forEach((socket) => socket.destroy());
      await new Promise<void>((resolve) => blackhole.close(() => resolve()));
    }
  });

  it('rejects preflight failures without opening an HTTP request', async () => {
    const request = mockLocalConnection();
    for (const config of [{ url: 'http://webhook.example/secret' }, { url: 'https://127.0.0.1/secret' }]) {
      expect(await provider().get('generic-webhook')!.trigger(config, {})).toEqual({
        status: 'rejected',
        httpStatus: null,
      });
    }
    const dnsFailure = provider(false, async () => {
      throw new Error('resolver-secret');
    }).get('generic-webhook')!;
    expect(await dnsFailure.trigger({ url: endpoint }, {})).toEqual({ status: 'rejected', httpStatus: null });
    expect(
      await provider()
        .get('generic-webhook')!
        .trigger({ url: endpoint }, { idempotencyKey: 'invalid\r\nheader' }),
    ).toEqual({ status: 'rejected', httpStatus: null });
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects a synchronous failure to open a request before any send begins', async () => {
    vi.spyOn(https, 'request').mockImplementation(() => {
      throw new Error('request-setup-secret');
    });
    expect(await provider().get('generic-webhook')!.trigger({ url: endpoint }, {})).toEqual({
      status: 'rejected',
      httpStatus: null,
    });
    expect(calls).toHaveLength(0);
  });

  it('preserves an unknown outcome when ending the request throws after the send begins', async () => {
    const request = mockLocalConnection();
    const mock = request.getMockImplementation()!;
    request.mockImplementation(((...args: Parameters<typeof https.request>) => {
      const outgoing = mock(...args);
      const end = outgoing.end.bind(outgoing);
      outgoing.end = (() => {
        end();
        outgoing.destroy();
        throw new Error('uncertain-send-secret');
      }) as typeof outgoing.end;
      return outgoing;
    }) as typeof https.request);
    expect(await provider().get('generic-webhook')!.trigger({ url: endpoint }, {})).toEqual({
      status: 'unknown',
      reason: 'request_failed',
    });
  });

  it('revalidates the destination at execution and never connects to a changed forbidden address', async () => {
    const request = mockLocalConnection();
    const resolver = vi.fn().mockResolvedValueOnce([publicAddress]).mockResolvedValue(['169.254.169.254']);
    const p = provider(false, resolver).get('generic-webhook')!;
    await p.validateDestination({ url: endpoint });
    expect(await p.trigger({ url: endpoint }, {})).toEqual({ status: 'rejected', httpStatus: null });
    expect(request).not.toHaveBeenCalled();
  });

  it('honours an already aborted worker without opening a request', async () => {
    const request = mockLocalConnection();
    const controller = new AbortController();
    controller.abort();
    expect(
      await provider().get('portainer-webhook')!.trigger({ url: endpoint }, { signal: controller.signal }),
    ).toEqual({ status: 'rejected', httpStatus: null });
    expect(request).not.toHaveBeenCalled();
  });
});
