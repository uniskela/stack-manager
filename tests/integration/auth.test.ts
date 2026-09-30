import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as login from '@/app/api/auth/login/route';
import * as logout from '@/app/api/auth/logout/route';
import * as passwordRoute from '@/app/api/auth/password/route';
import * as sessionsRoute from '@/app/api/auth/sessions/route';
import * as sessionById from '@/app/api/auth/sessions/[sessionId]/route';
import * as sessionRoute from '@/app/api/auth/session/route';
import * as health from '@/app/api/health/route';
import * as setup from '@/app/api/setup/route';
import * as workspaces from '@/app/api/workspaces/route';
import { sessions, users } from '@/server/persistence/schema';
import { openSqlite } from '@/server/persistence/sqlite/database';
import { createHarness, type TestHarness } from '../support/container';
import { call, cookieFrom } from '../support/http';

const PASSWORD = 'correct horse battery staple';
let h: TestHarness;

beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => h.cleanup());

async function setupAdmin() {
  const res = await call(setup.POST, { method: 'POST', body: { username: 'admin', password: PASSWORD } });
  expect(res.status).toBe(201);
  return cookieFrom(res);
}

describe('first-run setup', () => {
  it('reports setup state and creates the admin exactly once', async () => {
    expect((await call(setup.GET)).json).toEqual({ setupRequired: true, setupTokenRequired: false });
    const res = await call(setup.POST, { method: 'POST', body: { username: 'Admin', password: PASSWORD } });
    expect(res.status).toBe(201);
    expect(res.json.user).toMatchObject({ username: 'admin', role: 'admin' });
    expect(JSON.stringify(res.json)).not.toMatch(/hash|password/i);

    const again = await call(setup.POST, { method: 'POST', body: { username: 'other', password: PASSWORD } });
    expect(again.status).toBe(409);
    expect((await call(setup.GET)).json.setupRequired).toBe(false);
    expect(await h.container.repos.users.count()).toBe(1);
  });

  it('stores an Argon2id hash, never the password', async () => {
    await setupAdmin();
    const record = await h.container.repos.users.findByUsername('admin');
    expect(record!.passwordHash).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
    expect(record!.passwordHash).not.toContain(PASSWORD);
    const dbBytes = fs.readFileSync(path.join(h.dataDir, 'stack-manager.sqlite'));
    expect(dbBytes.includes(Buffer.from(PASSWORD))).toBe(false);
  });

  it('rejects weak passwords and passwords containing the username', async () => {
    const short = await call(setup.POST, { method: 'POST', body: { username: 'admin', password: 'short' } });
    expect(short.status).toBe(400);
    expect(short.json.error.fields.password).toBeTruthy();
    const containsUser = await call(setup.POST, {
      method: 'POST',
      body: { username: 'admin', password: 'admin-password-123' },
    });
    expect(containsUser.status).toBe(400);
  });

  it('requires the setup token when configured', async () => {
    await h.cleanup();
    h = await createHarness({ env: { STACK_MANAGER_SETUP_TOKEN: 'setup-token-0123456789' } });
    expect((await call(setup.GET)).json.setupTokenRequired).toBe(true);
    const denied = await call(setup.POST, {
      method: 'POST',
      body: { username: 'admin', password: PASSWORD },
    });
    expect(denied.status).toBe(403);
    const wrong = await call(setup.POST, {
      method: 'POST',
      body: { username: 'admin', password: PASSWORD, setupToken: 'wrong-token-0123456789' },
    });
    expect(wrong.status).toBe(403);
    const ok = await call(setup.POST, {
      method: 'POST',
      body: { username: 'admin', password: PASSWORD, setupToken: 'setup-token-0123456789' },
    });
    expect(ok.status).toBe(201);
  });
});

describe('sessions', () => {
  it('issues an HTTP-only SameSite cookie and stores only a keyed hash of the token', async () => {
    const res = await call(setup.POST, { method: 'POST', body: { username: 'admin', password: PASSWORD } });
    const setCookie = res.headers.get('set-cookie')!;
    expect(setCookie).toMatch(/^sm_session=/);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/');
    const token = decodeURIComponent(cookieFrom(res).split('=')[1]!);
    const db = openSqlite(path.join(h.dataDir, 'stack-manager.sqlite'));
    const stored = db.db.select().from(sessions).all();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.id).not.toBe(token);
    expect(stored[0]!.id).toMatch(/^[0-9a-f]{64}$/);
    expect(db.db.select().from(users).all()[0]!.passwordHash).toMatch(/^\$argon2id/);
    db.close();
  });

  it('uses __Host- prefixed Secure cookies when secure cookies are enabled', async () => {
    await h.cleanup();
    h = await createHarness({ env: { STACK_MANAGER_COOKIE_SECURE: 'true' } });
    const res = await call(setup.POST, { method: 'POST', body: { username: 'admin', password: PASSWORD } });
    const setCookie = res.headers.get('set-cookie')!;
    expect(setCookie).toMatch(/^__Host-sm_session=/);
    expect(setCookie).toContain('Secure');
    expect(setCookie).not.toContain('Domain=');
  });

  it('supports login, session lookup, logout and rejects the old cookie afterwards', async () => {
    await setupAdmin();
    const bad = await call(login.POST, {
      method: 'POST',
      body: { username: 'admin', password: 'wrong password!!' },
    });
    expect(bad.status).toBe(401);
    expect(bad.json.error.message).toBe('Invalid username or password.');
    const unknown = await call(login.POST, {
      method: 'POST',
      body: { username: 'ghost', password: PASSWORD },
    });
    expect(unknown.status).toBe(401);
    expect(unknown.json.error.message).toBe(bad.json.error.message);

    const ok = await call(login.POST, { method: 'POST', body: { username: 'ADMIN', password: PASSWORD } });
    expect(ok.status).toBe(200);
    const cookie = cookieFrom(ok);
    expect((await call(sessionRoute.GET, { cookie })).json.user.username).toBe('admin');

    const out = await call(logout.POST, { method: 'POST', cookie });
    expect(out.status).toBe(200);
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await call(sessionRoute.GET, { cookie })).status).toBe(401);
  });

  it('expires sessions after the TTL', async () => {
    const cookie = await setupAdmin();
    expect((await call(sessionRoute.GET, { cookie })).status).toBe(200);
    h.clock.advance(h.config.sessionTtlMs + 1000);
    expect((await call(sessionRoute.GET, { cookie })).status).toBe(401);
  });

  it('rejects forged and oversized session tokens', async () => {
    await setupAdmin();
    expect((await call(sessionRoute.GET, { cookie: 'sm_session=forged' })).status).toBe(401);
    expect((await call(sessionRoute.GET, { cookie: `sm_session=${'a'.repeat(5000)}` })).status).toBe(401);
  });

  it('rate-limits repeated login failures', async () => {
    await setupAdmin();
    for (let i = 0; i < 10; i++) {
      await call(login.POST, {
        method: 'POST',
        body: { username: 'admin', password: `wrong-password-${i}` },
      });
    }
    const limited = await call(login.POST, {
      method: 'POST',
      body: { username: 'admin', password: PASSWORD },
    });
    expect(limited.status).toBe(429);
  });

  it('does not trust X-Forwarded-For by default and does not pool unknown clients', async () => {
    await setupAdmin();
    // Failures against other usernames from "unknown" clients must not lock out the admin.
    for (let i = 0; i < 12; i++) {
      await call(login.POST, {
        method: 'POST',
        body: { username: `ghost${i}`, password: 'wrong password!!' },
      });
    }
    expect(
      (await call(login.POST, { method: 'POST', body: { username: 'admin', password: PASSWORD } })).status,
    ).toBe(200);
    // Rotating a spoofed X-Forwarded-For does not escape the per-username limit.
    for (let i = 0; i < 10; i++) {
      await call(login.POST, {
        method: 'POST',
        body: { username: 'admin', password: `wrong-password-${i}` },
        headers: { 'x-forwarded-for': `198.51.100.${i}` },
      });
    }
    const limited = await call(login.POST, {
      method: 'POST',
      body: { username: 'admin', password: PASSWORD },
      headers: { 'x-forwarded-for': '198.51.100.200' },
    });
    expect(limited.status).toBe(429);
  });

  it('uses the trusted proxy hop count to key rate limits by client address', async () => {
    await h.cleanup();
    h = await createHarness({ env: { STACK_MANAGER_TRUSTED_PROXY_HOPS: '1' } });
    await setupAdmin();
    const from = (ip: string, username: string) =>
      call(login.POST, {
        method: 'POST',
        body: { username, password: 'wrong password!!' },
        headers: { 'x-forwarded-for': `6.6.6.6, ${ip}` },
      });
    for (let i = 0; i < 10; i++) await from('203.0.113.5', `user${i}`);
    expect((await from('203.0.113.5', 'another')).status).toBe(429);
    expect((await from('203.0.113.6', 'another')).status).toBe(401);
  });

  it('never logs or audits passwords or session tokens', async () => {
    const res = await call(setup.POST, { method: 'POST', body: { username: 'admin', password: PASSWORD } });
    const token = decodeURIComponent(cookieFrom(res).split('=')[1]!);
    await call(login.POST, {
      method: 'POST',
      body: { username: 'admin', password: 'another wrong password' },
    });
    await call(login.POST, { method: 'POST', body: { username: 'admin', password: PASSWORD } });
    const audit = JSON.stringify(await h.container.audit.list({ limit: 100 }));
    const logs = h.logs.join('\n');
    for (const needle of [PASSWORD, 'another wrong password', token]) {
      expect(audit).not.toContain(needle);
      expect(logs).not.toContain(needle);
    }
    expect(audit).toContain('auth.login_failed');
  });
});

describe('account', () => {
  const NEW_PASSWORD = 'fresh horse battery staple';

  async function secondSessionCookie() {
    const res = await call(login.POST, {
      method: 'POST',
      body: { username: 'admin', password: PASSWORD },
      headers: { 'user-agent': 'OtherBrowser/1.0' },
    });
    expect(res.status).toBe(200);
    return cookieFrom(res);
  }

  it('changes password, revokes other sessions, keeps current, and audits without leaking secrets', async () => {
    const cookieA = await setupAdmin();
    const cookieB = await secondSessionCookie();
    expect((await call(sessionRoute.GET, { cookie: cookieB })).status).toBe(200);

    const bad = await call(passwordRoute.POST, {
      method: 'POST',
      cookie: cookieA,
      body: { currentPassword: 'wrong', newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD },
    });
    expect(bad.status).toBe(401);
    expect(bad.json.error.message).toBe('Current password is incorrect.');
    expect(JSON.stringify(bad.json)).not.toMatch(/hash|argon/i);

    const mismatch = await call(passwordRoute.POST, {
      method: 'POST',
      cookie: cookieA,
      body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD, confirmPassword: 'no-match-here!!' },
    });
    expect(mismatch.status).toBe(400);
    expect(mismatch.json.error.fields.confirmPassword).toBeTruthy();

    const ok = await call(passwordRoute.POST, {
      method: 'POST',
      cookie: cookieA,
      body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD },
    });
    expect(ok.status).toBe(200);
    expect(JSON.stringify(ok.json)).not.toMatch(/hash|password/i);

    expect((await call(sessionRoute.GET, { cookie: cookieA })).status).toBe(200);
    expect((await call(sessionRoute.GET, { cookie: cookieB })).status).toBe(401);
    expect(
      (await call(login.POST, { method: 'POST', body: { username: 'admin', password: PASSWORD } })).status,
    ).toBe(401);
    expect(
      (await call(login.POST, { method: 'POST', body: { username: 'admin', password: NEW_PASSWORD } }))
        .status,
    ).toBe(200);

    const audit = JSON.stringify(await h.container.audit.list({ limit: 50 }));
    expect(audit).toContain('auth.password_changed');
    expect(audit).not.toContain(PASSWORD);
    expect(audit).not.toContain(NEW_PASSWORD);
  });

  it('lists sessions with hashed ids and revokes one or all others', async () => {
    const cookieA = await setupAdmin();
    const cookieB = await secondSessionCookie();

    const list = await call(sessionsRoute.GET, { cookie: cookieA });
    expect(list.status).toBe(200);
    expect(list.json.sessions).toHaveLength(2);
    const current = list.json.sessions.find((s: { current: boolean }) => s.current);
    const other = list.json.sessions.find((s: { current: boolean }) => !s.current);
    expect(current).toBeTruthy();
    expect(other).toBeTruthy();
    expect(current.id).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(list.json)).not.toMatch(/^sm_session=/);

    const selfRevoke = await call(sessionById.DELETE, {
      method: 'DELETE',
      cookie: cookieA,
      params: { sessionId: current.id },
    });
    expect(selfRevoke.status).toBe(400);
    expect(selfRevoke.json.error.message).toMatch(/sign out/i);

    const unknownSession = await call(sessionById.DELETE, {
      method: 'DELETE',
      cookie: cookieA,
      params: { sessionId: 'b'.repeat(64) },
    });
    expect(unknownSession.status).toBe(404);

    const revokeOther = await call(sessionById.DELETE, {
      method: 'DELETE',
      cookie: cookieA,
      params: { sessionId: other.id },
    });
    expect(revokeOther.status).toBe(200);
    expect((await call(sessionRoute.GET, { cookie: cookieB })).status).toBe(401);
    expect((await call(sessionRoute.GET, { cookie: cookieA })).status).toBe(200);

    const cookieC = await secondSessionCookie();
    expect((await call(sessionsRoute.DELETE, { method: 'DELETE', cookie: cookieA })).json).toEqual({
      revoked: 1,
    });
    expect((await call(sessionRoute.GET, { cookie: cookieA })).status).toBe(200);
    expect((await call(sessionRoute.GET, { cookie: cookieC })).status).toBe(401);
  });

  it('requires authentication for account APIs', async () => {
    await setupAdmin();
    expect((await call(passwordRoute.POST, { method: 'POST', body: {} })).status).toBe(401);
    expect((await call(sessionsRoute.GET)).status).toBe(401);
    expect((await call(sessionsRoute.DELETE, { method: 'DELETE' })).status).toBe(401);
    expect(
      (await call(sessionById.DELETE, { method: 'DELETE', params: { sessionId: 'a'.repeat(64) } })).status,
    ).toBe(401);
  });
});

describe('request protection', () => {
  it('blocks unauthenticated access to protected APIs', async () => {
    await setupAdmin();
    expect((await call(workspaces.GET)).status).toBe(401);
    expect((await call(workspaces.POST, { method: 'POST', body: { name: 'x' } })).status).toBe(401);
    expect((await call(sessionRoute.GET)).status).toBe(401);
  });

  it('rejects cross-origin and origin-less mutations (CSRF)', async () => {
    const cookie = await setupAdmin();
    const evil = await call(workspaces.POST, {
      method: 'POST',
      body: { name: 'x' },
      cookie,
      origin: 'https://evil.example',
    });
    expect(evil.status).toBe(403);
    const none = await call(workspaces.POST, { method: 'POST', body: { name: 'x' }, cookie, origin: null });
    expect(none.status).toBe(403);
    const referer = await call(workspaces.POST, {
      method: 'POST',
      body: { name: 'Home' },
      cookie,
      origin: null,
      headers: { referer: 'http://stack.test/onboarding' },
    });
    expect(referer.status).toBe(201);
  });

  it('honours STACK_MANAGER_PUBLIC_URL for origin checks behind a proxy', async () => {
    await h.cleanup();
    h = await createHarness({ env: { STACK_MANAGER_PUBLIC_URL: 'https://stacks.example.com' } });
    const hostOnly = await call(setup.POST, {
      method: 'POST',
      body: { username: 'admin', password: PASSWORD },
    });
    expect(hostOnly.status).toBe(403);
    const ok = await call(setup.POST, {
      method: 'POST',
      body: { username: 'admin', password: PASSWORD },
      origin: 'https://stacks.example.com',
    });
    expect(ok.status).toBe(201);
  });

  it('accepts JSON bodies only', async () => {
    const res = await call(setup.POST, {
      method: 'POST',
      body: 'username=admin&password=x',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(res.status).toBe(415);
  });

  it('rejects oversized bodies by Content-Length and while streaming', async () => {
    const big = JSON.stringify({ username: 'admin', password: 'x'.repeat(70 * 1024) });
    const declared = await call(setup.POST, {
      method: 'POST',
      body: big,
      headers: { 'content-length': String(big.length) },
    });
    expect(declared.status).toBe(413);

    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(16 * 1024).fill(0x61));
        if (pulled > 1000) controller.close(); // never reached: the reader must stop at the cap
      },
    });
    const req = new Request('http://stack.test/api/setup', {
      method: 'POST',
      headers: { host: 'stack.test', origin: 'http://stack.test', 'content-type': 'application/json' },
      body: stream,
      duplex: 'half',
    } as RequestInit);
    const res = await setup.POST(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(413);
    expect(pulled).toBeLessThan(10);
  });

  it('health endpoint is public and minimal', async () => {
    const res = await call(health.GET);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ status: 'ok' });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});
