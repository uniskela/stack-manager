import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DecryptionError, SecretBox } from '@/server/security/secret-box';

const box = () => new SecretBox({ key: randomBytes(32), keyVersion: 1 });

describe('SecretBox (AES-256-GCM)', () => {
  it('round-trips and never stores plaintext', () => {
    const b = box();
    const enc = b.encrypt('ghp_supersecrettoken1234567890', 'aad');
    expect(enc.ciphertext).not.toContain('supersecret');
    expect(Buffer.from(enc.ciphertext, 'base64').toString('utf8')).not.toContain('supersecret');
    expect(enc.keyVersion).toBe(1);
    expect(b.decrypt(enc, 'aad')).toBe('ghp_supersecrettoken1234567890');
  });

  it('uses a fresh random nonce per encryption', () => {
    const b = box();
    const a1 = b.encrypt('same', 'aad');
    const a2 = b.encrypt('same', 'aad');
    expect(a1.nonce).not.toBe(a2.nonce);
    expect(a1.ciphertext).not.toBe(a2.ciphertext);
    expect(Buffer.from(a1.nonce, 'base64')).toHaveLength(12);
  });

  it('fails closed on tampered ciphertext, tag or nonce', () => {
    const b = box();
    const enc = b.encrypt('secret-value', 'aad');
    const raw = Buffer.from(enc.ciphertext, 'base64');
    const flipBody = Buffer.from(raw);
    flipBody[0]! ^= 0x01;
    const flipTag = Buffer.from(raw);
    flipTag[flipTag.length - 1]! ^= 0x01;
    const nonce = Buffer.from(enc.nonce, 'base64');
    nonce[0]! ^= 0x01;
    expect(() => b.decrypt({ ...enc, ciphertext: flipBody.toString('base64') }, 'aad')).toThrow(
      DecryptionError,
    );
    expect(() => b.decrypt({ ...enc, ciphertext: flipTag.toString('base64') }, 'aad')).toThrow(
      DecryptionError,
    );
    expect(() => b.decrypt({ ...enc, nonce: nonce.toString('base64') }, 'aad')).toThrow(DecryptionError);
    expect(() => b.decrypt({ ...enc, ciphertext: '' }, 'aad')).toThrow(DecryptionError);
  });

  it('binds ciphertext to its associated data', () => {
    const b = box();
    const enc = b.encrypt('secret-value', 'credential:A');
    expect(() => b.decrypt(enc, 'credential:B')).toThrow(DecryptionError);
  });

  it('fails closed with the wrong key or an unknown key version', () => {
    const enc = box().encrypt('secret-value', 'aad');
    expect(() => box().decrypt(enc, 'aad')).toThrow(DecryptionError);
    expect(() => box().decrypt({ ...enc, keyVersion: 9 }, 'aad')).toThrow(/unknown encryption key version/);
  });

  it('decrypts older key versions when the previous key is supplied', () => {
    const oldKey = randomBytes(32);
    const enc = new SecretBox({ key: oldKey, keyVersion: 1 }).encrypt('rotating', 'aad');
    const rotated = new SecretBox({ key: randomBytes(32), keyVersion: 2 }, [{ key: oldKey, keyVersion: 1 }]);
    expect(rotated.decrypt(enc, 'aad')).toBe('rotating');
    expect(rotated.encrypt('x', 'aad').keyVersion).toBe(2);
  });

  it('error messages do not leak key or plaintext material', () => {
    const b = box();
    const enc = b.encrypt('plaintext-marker', 'aad');
    try {
      b.decrypt(enc, 'other');
    } catch (error) {
      expect((error as Error).message).not.toMatch(/plaintext-marker/);
    }
  });
});
