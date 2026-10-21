import https from 'node:https';
import net from 'node:net';
import type { LookupFunction } from 'node:net';
import { z } from 'zod';
import { ValidationError } from '@/server/domain/errors';
import { resolveAllowedHost, type Resolver } from '@/server/security/network-policy';
import type {
  DeploymentConfiguration,
  DeploymentProvider,
  DeploymentProviderType,
  DeploymentTriggerResult,
} from './types';

export type {
  DeploymentConfiguration,
  DeploymentProvider,
  DeploymentProviderType,
  DeploymentTriggerResult,
} from './types';

const configuration = z
  .object({
    url: z.string().min(1).max(8192),
    bearerToken: z
      .string()
      .min(1)
      .max(4096)
      .regex(/^[\x21-\x7e]+$/)
      .optional(),
  })
  .strict();

interface ProviderOptions {
  allowPrivateNetworks: boolean;
  resolver?: Resolver;
  totalTimeoutMs?: number;
  connectTimeoutMs?: number;
}

/** POST contract: generic receives this fixed JSON, Portainer receives an empty body. */
export const GENERIC_DEPLOYMENT_BODY = '{"event":"deployment_requested"}';

class WebhookProvider implements DeploymentProvider {
  constructor(
    readonly type: DeploymentProviderType,
    private readonly options: ProviderOptions,
  ) {}

  validateConfiguration(input: unknown): DeploymentConfiguration {
    const parsed = configuration.safeParse(input);
    if (!parsed.success) throw new ValidationError('Invalid deployment webhook configuration.');
    let url: URL;
    try {
      url = new URL(parsed.data.url);
    } catch {
      throw new ValidationError('A valid HTTPS webhook URL is required.');
    }
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.hash ||
      /[\x00-\x20\x7f]/.test(parsed.data.url)
    ) {
      throw new ValidationError('Use an HTTPS webhook URL without embedded credentials or a fragment.');
    }
    if (this.type === 'portainer-webhook' && parsed.data.bearerToken !== undefined) {
      throw new ValidationError('Portainer webhooks authenticate using their secret URL.');
    }
    return parsed.data;
  }

  async validateDestination(config: DeploymentConfiguration): Promise<void> {
    const checked = this.validateConfiguration(config);
    await this.resolve(
      new URL(checked.url).hostname,
      AbortSignal.timeout(this.options.totalTimeoutMs ?? 15000),
    );
  }

  private async resolve(hostname: string, signal: AbortSignal): Promise<string[]> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const abort = () => reject(new ValidationError('Webhook destination validation timed out.'));
      signal.addEventListener('abort', abort, { once: true });
      resolveAllowedHost(hostname, this.options)
        .then(resolve, reject)
        .finally(() => signal.removeEventListener('abort', abort));
    });
  }

  async trigger(
    config: DeploymentConfiguration,
    options: { signal?: AbortSignal; idempotencyKey?: string },
  ): Promise<DeploymentTriggerResult> {
    const timeout = AbortSignal.timeout(this.options.totalTimeoutMs ?? 15000);
    const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
    try {
      const checked = this.validateConfiguration(config);
      const url = new URL(checked.url);
      const addresses = await this.resolve(url.hostname, signal);
      signal.throwIfAborted();
      // The socket consumes only this validated snapshot; Node never resolves the hostname again.
      const address = addresses[0]!;
      const lookup: LookupFunction = (_hostname, lookupOptions, callback) => {
        const family = net.isIP(address);
        if (lookupOptions.all) callback(null, [{ address, family }]);
        else callback(null, address, family);
      };
      const body = this.type === 'generic-webhook' ? GENERIC_DEPLOYMENT_BODY : '';
      const headers: Record<string, string> = { 'Content-Length': String(Buffer.byteLength(body)) };
      if (body) headers['Content-Type'] = 'application/json';
      if (checked.bearerToken) headers.Authorization = `Bearer ${checked.bearerToken}`;
      if (options.idempotencyKey && this.type === 'generic-webhook') {
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(options.idempotencyKey))
          throw new ValidationError('Invalid deployment attempt identifier.');
        headers['Idempotency-Key'] = options.idempotencyKey;
      }
      return await new Promise<DeploymentTriggerResult>((resolve) => {
        const request = https.request(
          url,
          { method: 'POST', headers, lookup, agent: false, signal, maxHeaderSize: 16384 },
          (response) => {
            const httpStatus = response.statusCode ?? 0;
            // No redirect following and no response content read or included in errors.
            resolve({ status: httpStatus >= 200 && httpStatus < 300 ? 'accepted' : 'rejected', httpStatus });
            response.destroy();
          },
        );
        const connectionTimer = setTimeout(
          () => request.destroy(new Error('connection_timeout')),
          this.options.connectTimeoutMs ?? 5000,
        );
        request.on('socket', (socket) => socket.once('secureConnect', () => clearTimeout(connectionTimer)));
        request.once('close', () => clearTimeout(connectionTimer));
        request.once('error', () =>
          resolve({
            status: 'unknown',
            reason: signal.aborted ? 'request_timeout_or_cancelled' : 'request_failed',
          }),
        );
        request.end(body);
      });
    } catch {
      return {
        status: 'unknown',
        reason: signal.aborted ? 'request_timeout_or_cancelled' : 'destination_unavailable',
      };
    }
  }
}

export function createDeploymentProviders(
  options: ProviderOptions,
): Map<DeploymentProviderType, DeploymentProvider> {
  return new Map(
    (['portainer-webhook', 'generic-webhook'] as const).map((type) => [
      type,
      new WebhookProvider(type, options),
    ]),
  );
}
