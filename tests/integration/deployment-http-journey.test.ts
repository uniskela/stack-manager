import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import https, { type RequestOptions } from 'node:https';
import type { LookupFunction } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as setup from '@/app/api/setup/route';
import * as binding from '@/app/api/workspaces/[workspaceId]/stacks/[stackId]/deployment/route';
import * as trigger from '@/app/api/workspaces/[workspaceId]/stacks/[stackId]/deployment/trigger/route';
import * as history from '@/app/api/workspaces/[workspaceId]/stacks/[stackId]/deployment/history/route';
import { createHarness } from '../support/container';
import { call, cookieFrom } from '../support/http';

afterEach(() => vi.restoreAllMocks());

describe('authenticated deployment HTTP to durable worker to local TLS receiver', () => {
  it.each(['portainer-webhook', 'generic-webhook'] as const)(
    'sends %s once and exposes only safe history',
    async (providerType) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-deploy-journey-'));
      let server: https.Server | undefined;
      let h: Awaited<ReturnType<typeof createHarness>> | undefined;
      try {
        const certPath = path.join(dir, 'cert.pem');
        const keyPath = path.join(dir, 'key.pem');
        execFileSync(
          'openssl',
          [
            'req',
            '-x509',
            '-newkey',
            'rsa:2048',
            '-nodes',
            '-keyout',
            keyPath,
            '-out',
            certPath,
            '-days',
            '1',
            '-subj',
            '/CN=deploy.example.test',
            '-addext',
            'subjectAltName=DNS:deploy.example.test',
          ],
          { stdio: 'ignore' },
        );
        const cert = fs.readFileSync(certPath);
        const received: Array<{
          body: string;
          auth: string | undefined;
          key: string | string[] | undefined;
        }> = [];
        server = https.createServer({ key: fs.readFileSync(keyPath), cert }, (req, res) => {
          let body = '';
          req.on('data', (chunk: Buffer) => {
            body += chunk.toString();
          });
          req.on('end', () => {
            received.push({ body, auth: req.headers.authorization, key: req.headers['idempotency-key'] });
            res.writeHead(202);
            res.end('synthetic-private-provider-response');
          });
        });
        await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
        const port = (server.address() as { port: number }).port;
        const original = https.request;
        // Only tests route a vetted synthetic hostname to the local mock; TLS hostname checks stay enabled.
        vi.spyOn(https, 'request').mockImplementation(((
          url: URL,
          options: RequestOptions,
          callback: (res: import('node:http').IncomingMessage) => void,
        ) => {
          const lookup: LookupFunction = (_hostname, opts, done) => {
            if (opts.all) done(null, [{ address: '127.0.0.1', family: 4 }]);
            else done(null, '127.0.0.1', 4);
          };
          return original(url, { ...options, lookup, port, ca: cert }, callback);
        }) as typeof https.request);
        h = await createHarness();
        const auth = await call(setup.POST, {
          method: 'POST',
          body: { username: 'admin', password: 'correct horse battery staple' },
        });
        const cookie = cookieFrom(auth);
        const w = await h.container.workspaces.create({ name: 'Journey' }, auth.json.user.id);
        const now = h.clock.now();
        await h.container.repos.gitRepositories.insert({
          id: 'r',
          workspaceId: w.id,
          name: 'Repo',
          gitProviderType: 'github',
          remoteUrl: 'https://example.test/repo.git',
          defaultBranch: 'main',
          credentialId: null,
          webhookCredentialId: null,
          localClonePath: 'repos/r',
          syncStatus: 'ready',
          lastSyncError: null,
          headSha: null,
          lastFetchedAt: null,
          lastSyncAttemptAt: null,
          lastSyncFailedAt: null,
          lastHeadChangedAt: null,
          autoAddStacks: false,
          autoFetchEnabled: false,
          autoFetchIntervalMinutes: null,
          createdAt: now,
          updatedAt: now,
        });
        await h.container.repos.stacks.insert({
          id: 's',
          workspaceId: w.id,
          repositoryId: 'r',
          name: 'Stack',
          slug: 'stack',
          rootPath: '',
          composePath: 'compose.yaml',
          createdAt: now,
          updatedAt: now,
        });
        const params = { workspaceId: w.id, stackId: 's' };
        const url = 'https://deploy.example.test/api/stacks/webhooks/synthetic-url-token';
        const saved = await call(binding.PUT, {
          method: 'PUT',
          cookie,
          params,
          body: {
            providerType,
            enabled: true,
            expectedRevision: null,
            configuration: {
              url,
              ...(providerType === 'generic-webhook' ? { bearerToken: 'synthetic-bearer-token' } : {}),
            },
          },
        });
        expect(saved.status).toBe(200);
        expect(saved.text).not.toContain(url);
        const requested = await call(trigger.POST, { method: 'POST', cookie, params, body: {} });
        expect(requested.status).toBeGreaterThanOrEqual(200);
        expect(requested.status).toBeLessThan(300);
        expect((await call(trigger.POST, { method: 'POST', cookie, params, body: {} })).status).toBe(409);
        expect(received).toHaveLength(0);
        expect(await h.container.worker.runOnce()).toBe(true);
        expect(received).toHaveLength(1);
        expect(received[0]).toMatchObject(
          providerType === 'generic-webhook'
            ? {
                body: '{"event":"deployment_requested"}',
                auth: 'Bearer synthetic-bearer-token',
                key: requested.json.attempt.id,
              }
            : { body: '', auth: undefined, key: undefined },
        );
        const result = await call(history.GET, { cookie, params });
        expect(result.json.attempts[0]).toMatchObject({ status: 'accepted', httpStatus: 202 });
        expect(result.text).not.toMatch(/synthetic-|secretCiphertext|credentialNonce|bindingRevision/);
        expect(h.logs.join('')).not.toMatch(
          /synthetic-url-token|synthetic-bearer-token|synthetic-private-provider-response/,
        );
        expect(await h.container.worker.runOnce()).toBe(false);
        expect(received).toHaveLength(1);
        const removed = await call(binding.DELETE, {
          method: 'DELETE',
          cookie,
          params,
          body: { expectedRevision: saved.json.binding.revision },
        });
        expect(removed.status).toBe(200);
        expect((await call(binding.GET, { cookie, params })).json.binding).toBeNull();
        expect((await call(history.GET, { cookie, params })).json.attempts[0].status).toBe('accepted');
        expect((await call(trigger.POST, { method: 'POST', cookie, params, body: {} })).status).toBe(409);
      } finally {
        try {
          await h?.cleanup();
        } finally {
          if (server) {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server!.close(() => resolve()));
          }
          fs.rmSync(dir, { recursive: true, force: true });
        }
      }
    },
  );
});
