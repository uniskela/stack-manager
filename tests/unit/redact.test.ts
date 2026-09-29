import { describe, expect, it } from 'vitest';
import { createLogger } from '@/server/observability/logger';
import { REDACTED, redact, safeErrorMessage, scrubString } from '@/server/security/redact';

describe('redact', () => {
  it('replaces sensitive keys at any depth', () => {
    const out = redact({
      password: 'hunter2hunter2',
      nested: { apiKey: 'k', Authorization: 'Bearer abc', sessionToken: 't', passwordHash: '$argon2id$...' },
      list: [{ secret: 's' }],
      credentialId: 'cred-123',
      keyVersion: 1,
      username: 'admin',
    }) as Record<string, unknown>;
    expect(out).toEqual({
      password: REDACTED,
      nested: { apiKey: REDACTED, Authorization: REDACTED, sessionToken: REDACTED, passwordHash: REDACTED },
      list: [{ secret: REDACTED }],
      credentialId: 'cred-123',
      keyVersion: 1,
      username: 'admin',
    });
  });

  it.each([
    ['https://user:ghp_abcdefghijklmnopqrstuv@github.com/org/repo.git', 'ghp_abcdefghijklmnopqrstuv'],
    ['Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig', 'eyJhbGciOiJIUzI1NiJ9'],
    ['Basic eC1hY2Nlc3MtdG9rZW46c2VjcmV0', 'eC1hY2Nlc3MtdG9rZW46c2VjcmV0'],
    [
      'token github_pat_11ABCDEFG0123456789_abcdefghijklmnop',
      'github_pat_11ABCDEFG0123456789_abcdefghijklmnop',
    ],
    ['gitlab glpat-abcdefghij1234567890', 'glpat-abcdefghij1234567890'],
    ['https://portainer.example/api/stacks/webhooks/3f2a9c1e-aaaa-bbbb-cccc-1234567890ab', '3f2a9c1e-aaaa'],
    ['https://hooks.example/deploy?token=s3cr3tvalue&x=1', 's3cr3tvalue'],
    ['-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAB3Nza\n-----END OPENSSH PRIVATE KEY-----', 'AAAAB3Nza'],
  ])('scrubs credential-shaped strings: %s', (input, leaked) => {
    const out = scrubString(input);
    expect(out).not.toContain(leaked);
    expect(out).toContain(REDACTED);
  });

  it('scrubs explicitly known secrets wherever they appear', () => {
    expect(scrubString('failed with plain-secret-value inside', { secrets: ['plain-secret-value'] })).toBe(
      `failed with ${REDACTED} inside`,
    );
  });

  it('handles errors, buffers, cycles and depth', () => {
    const cyc: Record<string, unknown> = { a: 1 };
    cyc.self = cyc;
    const out = redact({ err: new Error('https://u:p@h/x'), buf: Buffer.from('x'), cyc }) as Record<
      string,
      unknown
    >;
    expect(out.err).toEqual({ name: 'Error', message: `https://${REDACTED}@h/x` });
    expect(out.buf).toBe(REDACTED);
    expect((out.cyc as Record<string, unknown>).self).toBe('[Circular]');
  });

  it('safeErrorMessage scrubs and truncates', () => {
    const msg = safeErrorMessage(new Error(`fatal: https://x:${'a'.repeat(30)}@host ${'z'.repeat(1000)}`));
    expect(msg).not.toContain('a'.repeat(30));
    expect(msg.length).toBeLessThanOrEqual(501);
  });
});

describe('logger', () => {
  it('emits JSON lines with redacted fields', () => {
    const lines: string[] = [];
    const log = createLogger({ level: 'info', sink: (l) => lines.push(l) }).child({ component: 'test' });
    log.debug('hidden');
    log.info('connecting https://user:tok3n-value@git.example/x', {
      token: 'tok3n-value',
      headers: { cookie: 'sm=1' },
    });
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]!);
    expect(rec).toMatchObject({
      level: 'info',
      component: 'test',
      token: REDACTED,
      headers: { cookie: REDACTED },
    });
    expect(lines[0]).not.toContain('tok3n-value');
  });
});
