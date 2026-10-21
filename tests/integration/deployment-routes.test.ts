import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as deployment from '@/app/api/workspaces/[workspaceId]/stacks/[stackId]/deployment/route';
import * as history from '@/app/api/workspaces/[workspaceId]/stacks/[stackId]/deployment/history/route';
import * as trigger from '@/app/api/workspaces/[workspaceId]/stacks/[stackId]/deployment/trigger/route';
import * as setup from '@/app/api/setup/route';
import { createHarness, type TestHarness } from '../support/container';
import { call, cookieFrom } from '../support/http';

let h: TestHarness;
let cookie: string;
const params = { workspaceId: 'workspace', stackId: 'stack' };
beforeEach(async () => {
  h = await createHarness();
  cookie = cookieFrom(
    await call(setup.POST, {
      method: 'POST',
      body: { username: 'admin', password: 'correct horse battery staple' },
    }),
  );
});
afterEach(async () => h.cleanup());

describe('deployment authenticated HTTP boundaries', () => {
  it('requires a session for every deployment endpoint', async () => {
    for (const [handler, method, body] of [
      [deployment.GET, 'GET', undefined],
      [deployment.PUT, 'PUT', {}],
      [deployment.DELETE, 'DELETE', {}],
      [history.GET, 'GET', undefined],
      [trigger.POST, 'POST', {}],
    ] as const) {
      expect((await call(handler, { method, params, body })).status).toBe(401);
    }
  });
  it('requires same-origin validation before changing configuration or sending', async () => {
    for (const [handler, method] of [
      [deployment.PUT, 'PUT'],
      [deployment.DELETE, 'DELETE'],
      [trigger.POST, 'POST'],
    ] as const) {
      expect(
        (await call(handler, { method, params, cookie, origin: 'https://attacker.example', body: {} }))
          .status,
      ).toBe(403);
    }
  });
  it('rejects unknown fields before reaching deployment services', async () => {
    const response = await call(deployment.PUT, {
      method: 'PUT',
      params,
      cookie,
      body: {
        providerType: 'generic-webhook',
        enabled: true,
        expectedRevision: null,
        configuration: { url: 'https://hooks.example/deploy', headers: { authorization: 'synthetic' } },
      },
    });
    expect(response.status).toBe(400);
    expect(
      (
        await call(trigger.POST, {
          method: 'POST',
          params,
          cookie,
          body: { url: 'https://hooks.example/deploy' },
        })
      ).status,
    ).toBe(400);
  });
});
