import { ValidationError } from './errors';
import type { GitRepositoryConnection } from './git-repository';

export type RepositoryFetchSettings = Pick<
  GitRepositoryConnection,
  'autoFetchEnabled' | 'autoFetchIntervalMinutes'
>;
export interface ServerFetchPolicy {
  workerEnabled: boolean;
  autoFetchEnabled: boolean;
  autoFetchIntervalMinutes: number;
}

export function validateFetchInterval(minutes: number): void {
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 1440) {
    throw new ValidationError('Automatic fetch interval must be 5–1440 minutes.', {
      autoFetchIntervalMinutes: 'Use a whole number from 5 to 1440, or null to inherit.',
    });
  }
}

export function resolveRepositoryFetchPolicy(repository: RepositoryFetchSettings, server: ServerFetchPolicy) {
  validateFetchInterval(server.autoFetchIntervalMinutes);
  if (repository.autoFetchIntervalMinutes !== null)
    validateFetchInterval(repository.autoFetchIntervalMinutes);
  let disabledReason: 'worker' | 'server' | 'repository' | null = null;
  if (!server.workerEnabled) disabledReason = 'worker';
  else if (!server.autoFetchEnabled) disabledReason = 'server';
  else if (!repository.autoFetchEnabled) disabledReason = 'repository';
  return {
    enabled: disabledReason === null,
    disabledReason,
    intervalMinutes: repository.autoFetchIntervalMinutes ?? server.autoFetchIntervalMinutes,
    serverIntervalMinutes: server.autoFetchIntervalMinutes,
  };
}
