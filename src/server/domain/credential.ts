import { ValidationError } from './errors';

export const CREDENTIAL_KINDS = ['git', 'deployment', 'runtime', 'secret'] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

export type CredentialTestStatus = 'ok' | 'failed';

/** Persisted credential including the encrypted secret. Never leaves the server. */
export interface CredentialRecord {
  id: string;
  workspaceId: string;
  kind: CredentialKind;
  providerType: string;
  label: string;
  secretCiphertext: string;
  secretNonce: string;
  secretKeyVersion: number;
  secretHint: string;
  secretMeta: Record<string, string>;
  lastTestedAt: Date | null;
  lastTestStatus: CredentialTestStatus | null;
  lastTestMessage: string | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The only credential shape that crosses the API boundary: metadata plus a masked hint.
 * Built by whitelisting fields — ciphertext, nonce and plaintext are structurally absent.
 */
export interface CredentialView {
  id: string;
  workspaceId: string;
  kind: CredentialKind;
  providerType: string;
  label: string;
  hint: string;
  meta: Record<string, string>;
  keyVersion: number;
  lastTestedAt: string | null;
  lastTestStatus: CredentialTestStatus | null;
  lastTestMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toCredentialView(r: CredentialRecord): CredentialView {
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    kind: r.kind,
    providerType: r.providerType,
    label: r.label,
    hint: r.secretHint,
    meta: { ...r.secretMeta },
    keyVersion: r.secretKeyVersion,
    lastTestedAt: r.lastTestedAt?.toISOString() ?? null,
    lastTestStatus: r.lastTestStatus,
    lastTestMessage: r.lastTestMessage,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** "••••a1b2" for long secrets; fully masked for short ones so little entropy is revealed. */
export function maskSecret(secret: string): string {
  const s = secret.trim();
  return s.length >= 16 ? `••••${s.slice(-4)}` : '••••';
}

export const SECRET_MAX_LENGTH = 16 * 1024;

export function validateSecretValue(secret: unknown, field = 'secret'): string {
  if (typeof secret !== 'string' || secret.trim().length === 0) {
    throw new ValidationError('A secret value is required.', { [field]: 'Required.' });
  }
  if (secret.length > SECRET_MAX_LENGTH) {
    throw new ValidationError('Secret is too long.', { [field]: 'Too long.' });
  }
  // Token-style secrets only for now; multi-line material (e.g. SSH keys) arrives with SSH remote support.
  if (/[\u0000-\u001f\u007f]/.test(secret.trim())) {
    throw new ValidationError('Secret contains invalid characters.', {
      [field]: 'Control characters are not allowed.',
    });
  }
  return secret.trim();
}

export function validateLabel(input: string): string {
  const label = input.trim().replace(/\s+/g, ' ');
  if (label.length < 1 || label.length > 80 || /[\u0000-\u001f\u007f]/.test(label)) {
    throw new ValidationError('Invalid label.', { label: 'Use 1–80 printable characters.' });
  }
  return label;
}

/**
 * Credential metadata must be non-secret. Only allowlisted keys with short printable values are kept;
 * anything that looks like a secret is rejected rather than silently stored.
 */
const META_KEYS = new Set(['username', 'host', 'scopesHint', 'note']);

export function validateSecretMeta(meta: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(meta ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    if (!META_KEYS.has(key)) {
      throw new ValidationError('Unsupported credential metadata.', { [`meta.${key}`]: 'Unknown field.' });
    }
    if (typeof value !== 'string' || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new ValidationError('Invalid credential metadata.', {
        [`meta.${key}`]: 'Use up to 200 printable characters.',
      });
    }
    out[key] = value.trim();
  }
  return out;
}
