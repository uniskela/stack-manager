import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as credential from '@/app/api/workspaces/[workspaceId]/credentials/[credentialId]/route';
import * as secretRoute from '@/app/api/workspaces/[workspaceId]/credentials/[credentialId]/secret/route';
import * as credentials from '@/app/api/workspaces/[workspaceId]/credentials/route';
import * as setup from '@/app/api/setup/route';
import * as workspaces from '@/app/api/workspaces/route';
import { testConfig } from '../support/config';
import { createHarness, type TestHarness } from '../support/container';
import { call, cookieFrom } from '../support/http';

const TOKEN = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
const TOKEN_2 = 'ghp_' + 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2';

let h: TestHarness;
let cookie: string;
let workspaceId: string;

beforeEach(async () => {
  h = await createHarness();
  cookie = cookieFrom(
    await call(setup.POST, {
      method: 'POST',
      body: { username: 'admin', password: 'correct horse battery staple' },
    }),
  );
  workspaceId = (await call(workspaces.POST, { method: 'POST', body: { name: 'Homelab' }, cookie })).json
    .workspace.id;
});
afterEach(async () => h.cleanup());

async function createCredential(secret = TOKEN) {
  const res = await call(credentials.POST, {
    method: 'POST',
    cookie,
    params: { workspaceId },
    body: { kind: 'git', providerType: 'github', label: 'Deploy bot', secret, meta: { username: 'bot' } },
  });
  expect(res.status).toBe(201);
  return res;
}

function readDb(): Buffer {
  // Include the WAL so freshly written rows are inspected too.
  const base = path.join(h.dataDir, 'stack-manager.sqlite');
  return Buffer.concat([base, `${base}-wal`].filter(fs.existsSync).map((f) => fs.readFileSync(f)));
}

describe('provider credentials API', () => {
  it('create returns masked metadata only', async () => {
    const res = await createCredential();
    expect(res.json.credential).toMatchObject({
      label: 'Deploy bot',
      hint: '••••Q7r8',
      kind: 'git',
      meta: { username: 'bot' },
    });
    expect(res.text).not.toContain(TOKEN);
    expect(res.text).not.toMatch(/ciphertext|nonce|secretCiphertext/i);
  });

  it('GET list and GET one never include plaintext or ciphertext', async () => {
    const id = (await createCredential()).json.credential.id;
    const record = await h.container.repos.credentials.findById(workspaceId, id);
    const list = await call(credentials.GET, { cookie, params: { workspaceId } });
    const one = await call(credential.GET, { cookie, params: { workspaceId, credentialId: id } });
    for (const res of [list, one]) {
      expect(res.status).toBe(200);
      expect(res.text).not.toContain(TOKEN);
      expect(res.text).not.toContain(record!.secretCiphertext);
      expect(res.text).not.toContain(record!.secretNonce);
    }
  });

  it('stores ciphertext only (plaintext absent from the database file)', async () => {
    const id = (await createCredential()).json.credential.id;
    const record = await h.container.repos.credentials.findById(workspaceId, id);
    expect(record!.secretCiphertext).not.toContain(TOKEN);
    expect(readDb().includes(Buffer.from(TOKEN))).toBe(false);
  });

  it('replace-secret rotates the ciphertext without echoing and resets test status', async () => {
    const id = (await createCredential()).json.credential.id;
    await h.container.credentials.recordTestResult(id, 'ok', null);
    const before = await h.container.repos.credentials.findById(workspaceId, id);
    const res = await call(secretRoute.PUT, {
      method: 'PUT',
      cookie,
      params: { workspaceId, credentialId: id },
      body: { secret: TOKEN_2 },
    });
    expect(res.status).toBe(200);
    expect(res.text).not.toContain(TOKEN_2);
    expect(res.json.credential.hint).toBe('••••J3i2');
    expect(res.json.credential.lastTestStatus).toBeNull();
    const after = await h.container.repos.credentials.findById(workspaceId, id);
    expect(after!.secretCiphertext).not.toBe(before!.secretCiphertext);
    expect(after!.secretNonce).not.toBe(before!.secretNonce);
    const plain = await h.container.credentials.withPlaintext(workspaceId, id, async (s) => s);
    expect(plain).toBe(TOKEN_2);
  });

  it('PATCH cannot smuggle a secret and rejects secret-looking metadata', async () => {
    const id = (await createCredential()).json.credential.id;
    const withSecret = await call(credential.PATCH, {
      method: 'PATCH',
      cookie,
      params: { workspaceId, credentialId: id },
      body: { secret: 'x' },
    });
    expect(withSecret.status).toBe(400);
    const badMeta = await call(credential.PATCH, {
      method: 'PATCH',
      cookie,
      params: { workspaceId, credentialId: id },
      body: { meta: { token: TOKEN_2 } },
    });
    expect(badMeta.status).toBe(400);
    const ok = await call(credential.PATCH, {
      method: 'PATCH',
      cookie,
      params: { workspaceId, credentialId: id },
      body: { label: 'Renamed' },
    });
    expect(ok.json.credential.label).toBe('Renamed');
  });

  it('rejects unsupported kinds/provider types and is workspace-scoped', async () => {
    const res = await call(credentials.POST, {
      method: 'POST',
      cookie,
      params: { workspaceId },
      body: { kind: 'runtime', providerType: 'portainer-api', label: 'x', secret: 'y' },
    });
    expect(res.status).toBe(400);
    const id = (await createCredential()).json.credential.id;
    const other = (await call(workspaces.POST, { method: 'POST', body: { name: 'Other' }, cookie })).json
      .workspace.id;
    expect(
      (await call(credential.GET, { cookie, params: { workspaceId: other, credentialId: id } })).status,
    ).toBe(404);
  });

  it('requires authentication', async () => {
    expect((await call(credentials.GET, { params: { workspaceId } })).status).toBe(401);
    expect(
      (
        await call(credentials.POST, {
          method: 'POST',
          params: { workspaceId },
          body: { kind: 'git', providerType: 'github', label: 'x', secret: 'y' },
        })
      ).status,
    ).toBe(401);
  });

  it('fails closed when ciphertext is tampered with or copied to another record', async () => {
    const a = (await createCredential()).json.credential.id;
    const b = (await createCredential(TOKEN_2)).json.credential.id;
    const recA = (await h.container.repos.credentials.findById(workspaceId, a))!;
    // Copy A's ciphertext into B: AAD binding must reject it.
    await h.container.repos.credentials.updateSecret(b, {
      secretCiphertext: recA.secretCiphertext,
      secretNonce: recA.secretNonce,
      secretKeyVersion: recA.secretKeyVersion,
      secretHint: 'x',
      updatedAt: new Date(),
    });
    await expect(h.container.credentials.withPlaintext(workspaceId, b, async (s) => s)).rejects.toThrow(
      /could not be decrypted/,
    );
    // Flip a byte in A.
    const raw = Buffer.from(recA.secretCiphertext, 'base64');
    raw[3]! ^= 0xff;
    await h.container.repos.credentials.updateSecret(a, {
      ...recA,
      secretCiphertext: raw.toString('base64'),
      updatedAt: new Date(),
    });
    await expect(h.container.credentials.withPlaintext(workspaceId, a, async (s) => s)).rejects.toThrow(
      /could not be decrypted/,
    );
  });

  it('decrypts after a restart with the same master key', async () => {
    const id = (await createCredential()).json.credential.id;
    const { dataDir, config } = h;
    await h.container.close();
    const restarted = await createHarness({ dataDir, config });
    expect(await restarted.container.credentials.withPlaintext(workspaceId, id, async (s) => s)).toBe(TOKEN);
    await restarted.cleanup();
    h = await createHarness();
  });

  it('fails closed after restart with a different master key', async () => {
    const id = (await createCredential()).json.credential.id;
    const dataDir = h.dataDir;
    await h.container.close();
    const other = await createHarness({
      dataDir,
      config: { ...testConfig(dataDir), encryption: { key: randomBytes(32), keyVersion: 1 } },
    });
    await expect(other.container.credentials.withPlaintext(workspaceId, id, async (s) => s)).rejects.toThrow(
      /could not be decrypted/,
    );
    // Listing still works (metadata only), so the UI can show a clear error instead of crashing.
    expect(await other.container.credentials.list(workspaceId)).toHaveLength(1);
    await other.cleanup();
    h = await createHarness(); // keep afterEach cleanup valid
  });

  it('audit events for credential lifecycle carry no secret material', async () => {
    const id = (await createCredential()).json.credential.id;
    await call(secretRoute.PUT, {
      method: 'PUT',
      cookie,
      params: { workspaceId, credentialId: id },
      body: { secret: TOKEN_2 },
    });
    await call(credential.DELETE, { method: 'DELETE', cookie, params: { workspaceId, credentialId: id } });
    const events = await h.container.audit.list({ workspaceId, limit: 50 });
    expect(events.map((e) => e.action)).toEqual(
      expect.arrayContaining(['credential.create', 'credential.replace_secret', 'credential.delete']),
    );
    const text = JSON.stringify(events) + h.logs.join('\n');
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(TOKEN_2);
  });
});

describe('audit redaction API', () => {
  it('redacts sensitive keys and credential-shaped strings by default', async () => {
    await h.container.audit.record({
      action: 'repository.test',
      workspaceId,
      meta: {
        token: TOKEN,
        headers: { Authorization: `Bearer ${TOKEN}` },
        remote: `https://bot:${TOKEN}@github.com/acme/infra.git`,
        webhook: 'https://portainer.local/api/stacks/webhooks/0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b',
        note: `copied ${TOKEN} into a note`,
        custom: 'value-known-to-caller',
      },
      knownSecrets: ['value-known-to-caller'],
    });
    const [event] = await h.container.audit.list({ workspaceId, limit: 1 });
    const text = JSON.stringify(event);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain('0f1e2d3c-4b5a');
    expect(text).not.toContain('value-known-to-caller');
    expect(event!.meta.remote).toBe('https://[REDACTED]@github.com/acme/infra.git');
  });
});
