export type AuditAction =
  | 'auth.setup'
  | 'auth.login'
  | 'auth.login_failed'
  | 'auth.logout'
  | 'auth.password_changed'
  | 'auth.password_change_failed'
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
  | 'repository.delete'
  | 'stack.create'
  | 'stack.update'
  | 'stack.delete'
  | 'draft.save'
  | 'draft.discard'
  | 'git.commit'
  | 'git.push'
  | 'git.push_rejected'
  | 'git.commit_validation_overridden';

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
