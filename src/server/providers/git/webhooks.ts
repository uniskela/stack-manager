import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AuthenticationError, ValidationError } from '@/server/domain/errors';

const repository = z.object({ clone_url: z.string().max(2048) });
const push = z.object({
  ref: z.string().min(1).max(512),
  after: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
  repository,
});
const githubPush = push.extend({ deleted: z.boolean() });
const nativePush = push.extend({ deleted: z.boolean().optional() });

export interface VerifiedGitEvent {
  deliveryId: string;
  eventType: string;
  push: { ref: string; cloneUrl: string; deleted: boolean } | null;
}

interface GitWebhookAdapter {
  verify(headers: Headers, bytes: Uint8Array, secret: string): VerifiedGitEvent;
}

function verifySignature(value: string | null, bytes: Uint8Array, secret: string, prefixed: boolean) {
  const pattern = prefixed ? /^sha256=[0-9a-f]{64}$/ : /^[0-9a-f]{64}$/;
  if (!value || !pattern.test(value)) throw new AuthenticationError('Webhook authentication failed.');
  const supplied = Buffer.from(prefixed ? value.slice(7) : value, 'hex');
  const expected = createHmac('sha256', secret).update(bytes).digest();
  if (!timingSafeEqual(supplied, expected)) throw new AuthenticationError('Webhook authentication failed.');
}

function parseEvent(
  headers: Headers,
  bytes: Uint8Array,
  prefix: string,
  schema: typeof nativePush | typeof githubPush,
): VerifiedGitEvent {
  const deliveryId = headers.get(`${prefix}-delivery`);
  const eventType = headers.get(`${prefix}-event`);
  if (
    !deliveryId ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(deliveryId) ||
    !eventType ||
    !/^[a-z_]{1,64}$/.test(eventType)
  ) {
    throw new ValidationError('Invalid webhook metadata.');
  }
  // Even ignored events must contain valid JSON, but their event-specific payload is never trusted.
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new ValidationError('Malformed webhook JSON.');
  }
  if (eventType !== 'push') return { deliveryId, eventType, push: null };
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ValidationError('Invalid push payload.');
  const p = parsed.data;
  return {
    deliveryId,
    eventType,
    push: {
      ref: p.ref,
      cloneUrl: p.repository.clone_url,
      deleted: p.deleted === true || /^0+$/.test(p.after),
    },
  };
}

/** Native headers only: compatibility headers must never substitute for a provider's contract. */
const github: GitWebhookAdapter = {
  verify(headers, bytes, secret) {
    verifySignature(headers.get('x-hub-signature-256'), bytes, secret, true);
    return parseEvent(headers, bytes, 'x-github', githubPush);
  },
};
const gitea: GitWebhookAdapter = {
  verify(headers, bytes, secret) {
    verifySignature(headers.get('x-gitea-signature'), bytes, secret, false);
    return parseEvent(headers, bytes, 'x-gitea', nativePush);
  },
};
const forgejo: GitWebhookAdapter = {
  verify(headers, bytes, secret) {
    verifySignature(headers.get('x-forgejo-signature'), bytes, secret, false);
    return parseEvent(headers, bytes, 'x-forgejo', nativePush);
  },
};

export function gitWebhookAdapter(provider: string): GitWebhookAdapter {
  const adapters: Record<string, GitWebhookAdapter> = { github, gitea, forgejo };
  const adapter = Object.hasOwn(adapters, provider) ? adapters[provider] : undefined;
  if (!adapter) throw new AuthenticationError('Webhook authentication failed.');
  return adapter;
}
