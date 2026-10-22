import { describe, expect, it } from 'vitest';
import { auditActionLabel } from '@/shared/audit/labels';
import { auditEntityHref } from '@/shared/audit/links';
import type { AuditAction } from '@/server/domain/audit';

// Typed as a complete record so adding an AuditAction without updating this list fails typecheck.
const ALL_ACTIONS: Record<AuditAction, true> = {
  'deployment.routing_evaluated': true,
  'deployment.stack_skipped': true,
  'deployment.automatic_requested': true,
  'deployment.binding_created': true,
  'deployment.binding_updated': true,
  'deployment.destination_validated': true,
  'deployment.binding_disabled': true,
  'deployment.binding_removed': true,
  'deployment.secret_rotated': true,
  'deployment.requested': true,
  'deployment.accepted': true,
  'deployment.rejected': true,
  'deployment.unknown': true,
  'auth.setup': true,
  'auth.login': true,
  'auth.login_failed': true,
  'auth.logout': true,
  'auth.password_changed': true,
  'auth.password_change_failed': true,
  'auth.git_identity_updated': true,
  'workspace.create': true,
  'workspace.update': true,
  'credential.create': true,
  'credential.update': true,
  'credential.replace_secret': true,
  'credential.delete': true,
  'repository.create': true,
  'repository.update': true,
  'repository.test': true,
  'repository.sync_requested': true,
  'repository.sync': true,
  'repository.delete': true,
  'stack.create': true,
  'stack.update': true,
  'stack.delete': true,
  'draft.save': true,
  'draft.discard': true,
  'git.commit': true,
  'git.push': true,
  'git.push_rejected': true,
  'git.commit_validation_overridden': true,
};

describe('auditActionLabel', () => {
  it('maps known audit actions to human labels', () => {
    expect(auditActionLabel('auth.login')).toBe('Signed in');
    expect(auditActionLabel('auth.logout')).toBe('Signed out');
    expect(auditActionLabel('auth.login_failed')).toBe('Sign-in failed');
    expect(auditActionLabel('repository.create')).toBe('Repository connected');
    expect(auditActionLabel('draft.save')).toBe('Draft saved');
    expect(auditActionLabel('stack.create')).toBe('Stack added');
  });

  it('labels every audit action, including v0.6.0 deployment events', () => {
    for (const action of Object.keys(ALL_ACTIONS)) expect(auditActionLabel(action), action).not.toBe(action);
    expect(auditActionLabel('deployment.accepted')).toBe('Deployment request accepted by receiver');
    expect(auditActionLabel('deployment.destination_validated')).toContain('no request sent');
  });

  it('falls back to the raw action for unknown values', () => {
    expect(auditActionLabel('future.unknown_action')).toBe('future.unknown_action');
  });
});

describe('auditEntityHref', () => {
  const workspaceId = 'ws-1';

  it('links repositories and stacks in the workspace', () => {
    expect(auditEntityHref(workspaceId, 'repository', 'repo-1')).toBe('/w/ws-1/repositories/repo-1');
    expect(auditEntityHref(workspaceId, 'stack', 'stack-1')).toBe('/w/ws-1/stacks/stack-1');
  });

  it('returns null when the target is not linkable', () => {
    expect(auditEntityHref(workspaceId, 'credential', 'c-1')).toBeNull();
    expect(auditEntityHref(workspaceId, null, 'x')).toBeNull();
    expect(auditEntityHref(workspaceId, 'repository', null)).toBeNull();
  });
});
