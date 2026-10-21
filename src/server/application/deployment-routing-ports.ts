import type { DeploymentAttempt, PersistedRoutingDecision } from '@/server/domain/deployment';
import type { EnqueueJobInput } from './ports';

export interface RoutingSource {
  id: string;
  repositoryId: string;
  afterSha: string;
  activeStackIds: string[];
  ref: string | null;
  signingCredentialId: string | null;
  signingNonce: string | null;
  receivedAt: Date;
}
export interface RoutingRecord {
  decision: PersistedRoutingDecision;
  expectedHead: string | null;
  advanceHead: boolean;
  attempt?: DeploymentAttempt;
  job?: EnqueueJobInput;
}
export interface DeploymentRoutingRepository {
  hasPending(repositoryId: string): Promise<boolean>;
  sourceValid(attemptId: string): Promise<boolean>;
  pending(repositoryId: string): Promise<RoutingSource[]>;
  record(
    source: RoutingSource,
    records: RoutingRecord[],
    lease: { id: string; owner: string },
    now: Date,
  ): Promise<PersistedRoutingDecision[]>;
  history(workspaceId: string, stackId: string): Promise<PersistedRoutingDecision[]>;
}
