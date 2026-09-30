/** Workspace-relative href for an audit event target, when resolvable. */
export function auditEntityHref(
  workspaceId: string,
  entityType: string | null,
  entityId: string | null,
): string | null {
  if (!entityType || !entityId) return null;
  if (entityType === 'repository') return `/w/${workspaceId}/repositories/${entityId}`;
  if (entityType === 'stack') return `/w/${workspaceId}/stacks/${entityId}`;
  return null;
}
