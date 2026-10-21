import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { gitWebhookAdapter } from '@/server/providers/git/webhooks';

const secret = 'synthetic-test-key-0123456789abcdef';
const id = 'f6266f16-1bf3-46a5-9ea4-602e06ead473';

describe.each(['github', 'gitea', 'forgejo'])('%s native signature boundary', (provider) => {
  const fixture = fs.readFileSync(`tests/fixtures/webhooks/${provider}-push.json`, 'utf8');
  const signatureHeader = provider === 'github' ? 'x-hub-signature-256' : `x-${provider}-signature`;
  function signed(body: string | Uint8Array = fixture, key = secret) {
    const digest = createHmac('sha256', key).update(body).digest('hex');
    return new Headers({
      [`x-${provider}-event`]: 'push',
      [`x-${provider}-delivery`]: id,
      [signatureHeader]: provider === 'github' ? `sha256=${digest}` : digest,
    });
  }
  const adapter = gitWebhookAdapter(provider);
  const bytes = Buffer.from(fixture);
  it('verifies its native provider-format fixture', () => {
    expect(adapter.verify(signed(), bytes, secret)).toMatchObject({
      eventType: 'push',
      deliveryId: id,
      push: { ref: 'refs/heads/main' },
    });
  });
  it.each([
    '',
    'sha1=' + 'a'.repeat(40),
    'sha256=',
    'f'.repeat(63),
    'g'.repeat(64),
    'sha512=' + 'a'.repeat(64),
  ])('rejects signature format %s', (value) => {
    const headers = signed();
    headers.set(signatureHeader, value);
    expect(() => adapter.verify(headers, bytes, secret)).toThrow(/authentication/);
  });
  it('rejects missing signature, wrong key, changed bytes, and compatibility-only headers', () => {
    const headers = signed();
    headers.delete(signatureHeader);
    headers.set(
      provider === 'github' ? 'x-gitea-signature' : 'x-hub-signature-256',
      'sha256=' + 'a'.repeat(64),
    );
    expect(() => adapter.verify(headers, bytes, secret)).toThrow(/authentication/);
    expect(() => adapter.verify(signed(), bytes, secret + 'x')).toThrow(/authentication/);
    expect(() => adapter.verify(signed(), Buffer.concat([bytes, Buffer.from(' ')]), secret)).toThrow(
      /authentication/,
    );
  });
  it('verifies original Unicode bytes before decoding', () => {
    const body = fixture + ' \n';
    const p = JSON.parse(body);
    p.note = '日本語 👋 é';
    const unicode = Buffer.from(JSON.stringify(p));
    expect(adapter.verify(signed(unicode), unicode, secret).push).not.toBeNull();
    const invalidUtf8 = Buffer.from([0xff]);
    expect(() => adapter.verify(signed(invalidUtf8), invalidUtf8, secret)).toThrow(/JSON/);
  });
  it('does not parse unsigned JSON and rejects correctly signed malformed JSON', () => {
    expect(() => adapter.verify(signed('{', secret + 'wrong'), Buffer.from('{'), secret)).toThrow(
      /authentication/,
    );
    expect(() => adapter.verify(signed('{'), Buffer.from('{'), secret)).toThrow(/JSON/);
  });
  it('requires native delivery and event metadata even when compatibility headers exist', () => {
    for (const field of ['event', 'delivery']) {
      const headers = signed();
      headers.delete(`x-${provider}-${field}`);
      headers.set(`x-gogs-${field}`, field === 'event' ? 'push' : id);
      expect(() => adapter.verify(headers, bytes, secret)).toThrow(/metadata/);
    }
  });
});
