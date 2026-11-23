import type { WudBinding, WudObservation } from '@/shared/image-updates';
import type { CredentialRecord } from '@/server/domain/credential';

export interface WudConnection {
  workspaceId: string;
  revision: string;
  baseUrl: string;
  credentialId: string;
  observations: WudObservation[];
  lastSuccessAt: Date;
  lastAttemptAt: Date;
  lastError: 'auth' | 'unavailable' | null;
}

export type WudStackBinding = WudBinding & { stackId: string; workspaceId: string };

export interface WudRepository {
  connection(workspaceId: string): Promise<WudConnection | null>;
  dueConnections(before: Date): Promise<Array<Pick<WudConnection, 'workspaceId' | 'revision'>>>;
  saveConnection(
    connection: WudConnection,
    credential: CredentialRecord,
    expectedRevision: string | null,
  ): Promise<void>;
  removeConnection(workspaceId: string, expectedRevision: string): Promise<void>;
  recordRefresh(
    workspaceId: string,
    revision: string,
    at: Date,
    result: { observations: WudObservation[] } | { error: NonNullable<WudConnection['lastError']> },
  ): Promise<void>;
  bindings(workspaceId: string): Promise<WudStackBinding[]>;
  setBinding(workspaceId: string, stackId: string, binding: WudBinding | null): Promise<void>;
}
