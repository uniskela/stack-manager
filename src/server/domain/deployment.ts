export type DeploymentProviderType = 'portainer-webhook' | 'generic-webhook';
export interface DeploymentBinding {
  id: string;
  workspaceId: string;
  stackId: string;
  providerType: DeploymentProviderType;
  credentialId: string;
  managedCredential: boolean;
  enabled: boolean;
  deployOnPush: boolean;
  revision: string;
  routingPolicy: import('@/shared/deployment-routing').RoutingPolicy | null;
  routingHeadSha: string | null;
  routingBranch: string | null;
  automationHold: boolean;
  lastAttemptAt: Date | null;
  lastAcceptedAt: Date | null;
  lastFailedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
export interface DeploymentAttempt {
  id: string;
  workspaceId: string;
  stackId: string;
  bindingId: string;
  providerType: DeploymentProviderType;
  actorUserId: string | null;
  triggerType: 'manual' | 'automatic';
  requestedAt: Date;
  status: 'queued' | 'running' | 'accepted' | 'rejected' | 'unknown';
  httpStatus: number | null;
  reason: string | null;
  completedAt: Date | null;
  bindingRevision: string;
  credentialNonce: string;
  jobId: string;
}
export const deploymentAttemptView = (a: DeploymentAttempt) => ({
  id: a.id,
  stackId: a.stackId,
  bindingId: a.bindingId,
  providerType: a.providerType,
  actorUserId: a.actorUserId,
  triggerType: a.triggerType,
  requestedAt: a.requestedAt.toISOString(),
  status: a.status,
  httpStatus: a.httpStatus,
  failureReason: a.reason,
  completedAt: a.completedAt?.toISOString() ?? null,
});

export interface PersistedRoutingDecision {
  id: string;
  repositoryId: string;
  sourceDeliveryId: string;
  stackId: string;
  bindingRevision: string | null;
  beforeSha: string | null;
  afterSha: string;
  matchedPaths: string[];
  decision: 'deploy' | 'skip' | 'blocked';
  reasonCode: string;
  explanation: string;
  attemptId: string | null;
  createdAt: Date;
  processedAt: Date;
}
