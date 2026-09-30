import { describe, expect, it } from 'vitest';
import { auditActionLabel } from '@/shared/audit/labels';
import { auditEntityHref } from '@/shared/audit/links';

describe('auditActionLabel', () => {
  it('maps known audit actions to human labels', () => {
    expect(auditActionLabel('auth.login')).toBe('Signed in');
    expect(auditActionLabel('auth.logout')).toBe('Signed out');
    expect(auditActionLabel('auth.login_failed')).toBe('Sign-in failed');
    expect(auditActionLabel('repository.create')).toBe('Repository connected');
    expect(auditActionLabel('draft.save')).toBe('Draft saved');
    expect(auditActionLabel('stack.create')).toBe('Stack added');
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
