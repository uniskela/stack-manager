import type { DeploymentProviderType } from '@/server/domain/deployment';
export type { DeploymentProviderType } from '@/server/domain/deployment';

/** Secret material: only decrypt server-side for validation or one trigger. */
export interface DeploymentConfiguration {
  url: string;
  bearerToken?: string;
}

export type DeploymentTriggerResult =
  | { status: 'accepted'; httpStatus: number }
  | { status: 'rejected'; httpStatus: number | null }
  | { status: 'unknown'; reason: string };

export interface DeploymentProvider {
  readonly type: DeploymentProviderType;
  validateConfiguration(input: unknown): DeploymentConfiguration;
  validateDestination(config: DeploymentConfiguration): Promise<void>;
  trigger(
    config: DeploymentConfiguration,
    options: { signal?: AbortSignal; idempotencyKey?: string },
  ): Promise<DeploymentTriggerResult>;
}
