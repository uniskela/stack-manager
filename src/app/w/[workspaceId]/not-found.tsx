import { FileQuestion } from 'lucide-react';
import { ButtonLink } from '@/ui/primitives/button';
import { EmptyState } from '@/ui/primitives/empty-state';

/** Rendered inside the workspace shell, so navigation stays available. */
export default function WorkspaceNotFound() {
  return (
    <EmptyState
      icon={FileQuestion}
      headingLevel={1}
      title="Page not found"
      actions={<ButtonLink href="/">Back to repositories</ButtonLink>}
    >
      That page does not exist, or it was removed.
    </EmptyState>
  );
}
