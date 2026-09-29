'use client';

import { FileQuestion } from 'lucide-react';
import { useParams } from 'next/navigation';
import { ButtonLink } from '@/ui/primitives/button';
import { EmptyState } from '@/ui/primitives/empty-state';

/** Rendered inside the workspace shell, so navigation stays available. */
export default function WorkspaceNotFound() {
  // not-found boundaries receive no props; read the workspace from the URL instead.
  const { workspaceId } = useParams<{ workspaceId: string }>();
  return (
    <EmptyState
      icon={FileQuestion}
      headingLevel={1}
      title="Page not found"
      actions={<ButtonLink href={`/w/${workspaceId}`}>Back to repositories</ButtonLink>}
    >
      That page does not exist, or it was removed.
    </EmptyState>
  );
}
