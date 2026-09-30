'use client';

import { Breadcrumbs } from '@/ui/primitives/breadcrumbs';
import { useStacksListHref } from './list-view-memory';

/** Stacks › repository › stack. "Stacks" returns to the list as it was left; the repository shows only its stacks. */
export function StackBreadcrumbs(props: {
  workspaceId: string;
  repository: { id: string; name: string };
  stackName: string;
}) {
  const listHref = useStacksListHref(props.workspaceId);
  const repoHref = `/w/${props.workspaceId}/stacks?repo=${encodeURIComponent(props.repository.id)}`;
  return (
    <Breadcrumbs
      items={[
        { label: 'Stacks', href: listHref },
        { label: props.repository.name, href: repoHref },
        { label: props.stackName },
      ]}
    />
  );
}
