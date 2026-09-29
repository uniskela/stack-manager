import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { AppError } from '@/server/domain/errors';

/**
 * AES-256-GCM authenticated encryption for provider credentials at rest.
 *
 * - 96-bit random nonce per encryption (never reused with the same key in practice).
 * - 128-bit auth tag appended to the ciphertext.
 * - Associated data binds a ciphertext to its owning record (e.g. credential id + workspace),
 *   so ciphertext copied between rows fails to decrypt.
 * - `keyVersion` is stored alongside each record to allow a future re-encryption job.
 *
 * All failures surface as `DecryptionError` with a generic message (fail closed; no oracle).
 */
export interface EncryptedSecret {
  ciphertext: string; // base64(ciphertext || tag)
  nonce: string; // base64
  keyVersion: number;
}

export class DecryptionError extends AppError {
  constructor(message = 'Stored credential could not be decrypted. Check STACK_MANAGER_ENCRYPTION_KEY.') {
    super(500, 'credential_unreadable', message);
  }
}

const ALGORITHM = 'aes-256-gcm';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export class SecretBox {
  readonly #keys: ReadonlyMap<number, Buffer>;
  readonly #currentVersion: number;

  constructor(
    current: { key: Buffer; keyVersion: number },
    previous: ReadonlyArray<{ key: Buffer; keyVersion: number }> = [],
  ) {
    if (current.key.length !== 32) throw new Error('SecretBox requires a 32-byte key');
    const keys = new Map<number, Buffer>();
    for (const k of previous) keys.set(k.keyVersion, Buffer.from(k.key));
    keys.set(current.keyVersion, Buffer.from(current.key));
    this.#keys = keys;
    this.#currentVersion = current.keyVersion;
  }

  get currentKeyVersion(): number {
    return this.#currentVersion;
  }

  encrypt(plaintext: string, associatedData: string): EncryptedSecret {
    const key = this.#keys.get(this.#currentVersion)!;
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(Buffer.from(associatedData, 'utf8'));
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      ciphertext: Buffer.concat([body, tag]).toString('base64'),
      nonce: nonce.toString('base64'),
      keyVersion: this.#currentVersion,
    };
  }

  decrypt(secret: EncryptedSecret, associatedData: string): string {
    const key = this.#keys.get(secret.keyVersion);
    if (!key) throw new DecryptionError('Stored credential uses an unknown encryption key version.');
    try {
      const nonce = Buffer.from(secret.nonce, 'base64');
      const raw = Buffer.from(secret.ciphertext, 'base64');
      if (nonce.length !== NONCE_BYTES || raw.length < TAG_BYTES) throw new DecryptionError();
      const decipher = createDecipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_BYTES });
      decipher.setAAD(Buffer.from(associatedData, 'utf8'));
      decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
      return Buffer.concat([
        decipher.update(raw.subarray(0, raw.length - TAG_BYTES)),
        decipher.final(),
      ]).toString('utf8');
    } catch (error) {
      if (error instanceof DecryptionError) throw error;
      throw new DecryptionError();
    }
  }
}
