export type AuditAction =
  | 'auth.setup'
  | 'auth.login'
  | 'auth.login_failed'
  | 'auth.logout'
  | 'workspace.create'
  | 'workspace.update'
  | 'credential.create'
  | 'credential.update'
  | 'credential.replace_secret'
  | 'credential.delete'
  | 'repository.create'
  | 'repository.update'
  | 'repository.test'
  | 'repository.sync_requested'
  | 'repository.sync'
  | 'repository.delete';

export interface AuditEvent {
  id: string;
  createdAt: Date;
  actorUserId: string | null;
  workspaceId: string | null;
  action: AuditAction;
  outcome: 'success' | 'failure';
  entityType: string | null;
  entityId: string | null;
  meta: Record<string, unknown>;
}
