import type { Clock } from '@/server/domain/clock';
import {
  CREDENTIAL_KINDS,
  maskSecret,
  toCredentialView,
  validateLabel,
  validateSecretMeta,
  validateSecretValue,
  validateWebhookSecret,
  type CredentialKind,
  type CredentialRecord,
  type CredentialView,
} from '@/server/domain/credential';
import { ConflictError, NotFoundError, ValidationError } from '@/server/domain/errors';
import type { SecretBox } from '@/server/security/secret-box';
import type { AuditService } from './audit-service';
import type { CredentialRepository } from './ports';

export interface CreateCredentialInput {
  workspaceId: string;
  kind: CredentialKind;
  providerType: string;
  label: string;
  secret: string;
  meta?: Record<string, unknown>;
}

/** Decides which provider types may own credentials of a given kind (backed by provider registries). */
export type ProviderTypeCheck = (kind: CredentialKind, providerType: string) => boolean;

/** Associated data binds each ciphertext to its record; copying ciphertext between rows fails to decrypt. */
export const credentialAad = (workspaceId: string, credentialId: string) =>
  `stack-manager:credential:v1:${workspaceId}:${credentialId}`;

/**
 * Encrypted provider credentials (docs/public/AUTH_AND_CREDENTIALS.md).
 *
 * Public methods return `CredentialView` only — metadata and a masked hint. Plaintext is available
 * solely through `withPlaintext`, which is used server-side for connection tests and Git operations.
 */
export class CredentialService {
  constructor(
    private readonly repo: CredentialRepository,
    private readonly box: SecretBox,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly newId: () => string,
    private readonly isSupportedProvider: ProviderTypeCheck,
    private readonly validateDeploymentSecret?: (providerType: string, secret: string) => Promise<string>,
  ) {}

  async prepare(input: CreateCredentialInput, actorUserId: string): Promise<CredentialRecord> {
    if (!CREDENTIAL_KINDS.includes(input.kind)) {
      throw new ValidationError('Invalid credential kind.', { kind: 'Unknown kind.' });
    }
    if (!this.isSupportedProvider(input.kind, input.providerType)) {
      throw new ValidationError('Unsupported provider type for this credential kind.', {
        providerType: 'Unsupported.',
      });
    }
    const label = validateLabel(input.label);
    let secret =
      input.kind === 'git_webhook' ? validateWebhookSecret(input.secret) : validateSecretValue(input.secret);
    if (input.kind === 'deployment') {
      if (!this.validateDeploymentSecret)
        throw new ValidationError('Deployment credentials are unavailable.');
      secret = await this.validateDeploymentSecret(input.providerType, secret);
      if (Object.keys(input.meta ?? {}).length)
        throw new ValidationError('Deployment credentials do not support metadata.');
    }
    const meta = validateSecretMeta(input.meta);
    const id = this.newId();
    const now = this.clock.now();
    const encrypted = this.box.encrypt(secret, credentialAad(input.workspaceId, id));
    const record: CredentialRecord = {
      id,
      workspaceId: input.workspaceId,
      kind: input.kind,
      providerType: input.providerType,
      label,
      secretCiphertext: encrypted.ciphertext,
      secretNonce: encrypted.nonce,
      secretKeyVersion: encrypted.keyVersion,
      secretHint: ['git_webhook', 'deployment'].includes(input.kind) ? '••••' : maskSecret(secret),
      secretMeta: meta,
      lastTestedAt: null,
      lastTestStatus: null,
      lastTestMessage: null,
      createdByUserId: actorUserId,
      createdAt: now,
      updatedAt: now,
    };
    return record;
  }

  async create(input: CreateCredentialInput, actorUserId: string): Promise<CredentialView> {
    const record = await this.prepare(input, actorUserId);
    await this.repo.insert(record);
    await this.audit.record({
      action: 'credential.create',
      actorUserId,
      workspaceId: input.workspaceId,
      entityType: 'credential',
      entityId: record.id,
      meta: { kind: input.kind, providerType: input.providerType },
    });
    return toCredentialView(record);
  }

  async list(workspaceId: string): Promise<CredentialView[]> {
    return (await this.repo.list(workspaceId)).map(toCredentialView);
  }

  async get(workspaceId: string, id: string): Promise<CredentialView> {
    return toCredentialView(await this.#find(workspaceId, id));
  }

  async update(
    workspaceId: string,
    id: string,
    input: { label?: string; meta?: Record<string, unknown> },
    actorUserId: string,
  ): Promise<CredentialView> {
    const existing = await this.#find(workspaceId, id);
    if (existing.kind === 'deployment' && input.meta !== undefined)
      throw new ValidationError('Deployment credentials do not support metadata.');
    const label = input.label === undefined ? undefined : validateLabel(input.label);
    const secretMeta = input.meta === undefined ? undefined : validateSecretMeta(input.meta);
    const updatedAt = this.clock.now();
    await this.repo.updateDetails(id, { label, secretMeta, updatedAt });
    await this.audit.record({
      action: 'credential.update',
      actorUserId,
      workspaceId,
      entityType: 'credential',
      entityId: id,
      meta: { labelChanged: label !== undefined, metaChanged: secretMeta !== undefined },
    });
    return this.get(workspaceId, existing.id);
  }

  /** Replace-only: the old secret is never returned; the new one is never echoed. */
  async replaceSecret(
    workspaceId: string,
    id: string,
    secretInput: string,
    actorUserId: string,
  ): Promise<CredentialView> {
    const existing = await this.#find(workspaceId, id);
    let secret =
      existing.kind === 'git_webhook' ? validateWebhookSecret(secretInput) : validateSecretValue(secretInput);
    if (existing.kind === 'deployment') {
      if (!this.validateDeploymentSecret)
        throw new ValidationError('Deployment credentials are unavailable.');
      secret = await this.validateDeploymentSecret(existing.providerType, secret);
    }
    const encrypted = this.box.encrypt(secret, credentialAad(workspaceId, id));
    await this.repo.updateSecret(id, {
      secretCiphertext: encrypted.ciphertext,
      secretNonce: encrypted.nonce,
      secretKeyVersion: encrypted.keyVersion,
      secretHint: ['git_webhook', 'deployment'].includes(existing.kind) ? '••••' : maskSecret(secret),
      updatedAt: this.clock.now(),
    });
    await this.audit.record({
      action: 'credential.replace_secret',
      actorUserId,
      workspaceId,
      entityType: 'credential',
      entityId: id,
      knownSecrets: [secret],
    });
    return this.get(workspaceId, id);
  }

  async delete(workspaceId: string, id: string, actorUserId: string): Promise<void> {
    await this.#find(workspaceId, id);
    if ((await this.repo.countReferences(id)) > 0) {
      throw new ConflictError(
        'Credential is in use by a repository connection or deployment binding.',
        'credential_in_use',
      );
    }
    await this.repo.delete(id);
    await this.audit.record({
      action: 'credential.delete',
      actorUserId,
      workspaceId,
      entityType: 'credential',
      entityId: id,
    });
  }

  /**
   * Decrypts the secret for the duration of `fn` only. Throws `DecryptionError` (fail closed) if the
   * key is wrong or the ciphertext was tampered with. Never pass the plaintext to logs or audit.
   */
  async withPlaintext<T>(
    workspaceId: string,
    id: string,
    fn: (secret: string, credential: CredentialView) => T | Promise<T>,
    expected?: { kind: CredentialKind; providerType: string; nonce?: string },
  ): Promise<T> {
    const record = await this.#find(workspaceId, id);
    if (
      expected &&
      (record.kind !== expected.kind ||
        record.providerType !== expected.providerType ||
        (expected.nonce !== undefined && record.secretNonce !== expected.nonce))
    ) {
      throw new ValidationError('Credential kind or provider does not match this operation.');
    }
    const secret = this.box.decrypt(
      { ciphertext: record.secretCiphertext, nonce: record.secretNonce, keyVersion: record.secretKeyVersion },
      credentialAad(workspaceId, id),
    );
    return fn(secret, toCredentialView(record));
  }

  async recordTestResult(id: string, status: 'ok' | 'failed', message: string | null): Promise<void> {
    await this.repo.recordTest(id, { at: this.clock.now(), status, message: message?.slice(0, 300) ?? null });
  }

  async #find(workspaceId: string, id: string): Promise<CredentialRecord> {
    const record = await this.repo.findById(workspaceId, id);
    if (!record) throw new NotFoundError('Credential not found.');
    return record;
  }
}
