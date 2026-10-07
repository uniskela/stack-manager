/** Human-readable labels for audit actions (shared by Dashboard and Activity). */
const LABELS: Record<string, string> = {
  'auth.setup': 'Admin account created',
  'auth.login': 'Signed in',
  'auth.login_failed': 'Sign-in failed',
  'auth.logout': 'Signed out',
  'auth.password_changed': 'Password changed',
  'auth.password_change_failed': 'Password change failed',
  'auth.git_identity_updated': 'Git identity updated',
  'workspace.create': 'Workspace created',
  'workspace.update': 'Workspace updated',
  'credential.create': 'Credential added',
  'credential.update': 'Credential updated',
  'credential.replace_secret': 'Credential secret replaced',
  'credential.delete': 'Credential removed',
  'repository.test': 'Repository connection tested',
  'repository.create': 'Repository connected',
  'repository.update': 'Repository updated',
  'repository.sync_requested': 'Repository fetch requested',
  'repository.sync': 'Repository fetched',
  'repository.delete': 'Repository removed',
  'stack.create': 'Stack added',
  'stack.update': 'Stack updated',
  'stack.delete': 'Stack removed',
  'draft.save': 'Draft saved',
  'draft.discard': 'Draft discarded',
  'git.commit': 'Drafts committed',
  'git.push': 'Git commit pushed',
  'git.push_rejected': 'Git push blocked',
  'git.commit_validation_overridden': 'Commit warnings acknowledged',
};

export function auditActionLabel(action: string): string {
  return LABELS[action] ?? action;
}
