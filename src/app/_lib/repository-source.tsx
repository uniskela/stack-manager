import 'server-only';
import { Hourglass } from 'lucide-react';
import { EmptyState } from '@/ui/primitives/empty-state';

/** Shown on the repository's Files/Docs/Changes tabs until the first successful fetch. */
export function NotFetched() {
  return (
    <EmptyState icon={Hourglass} title="Waiting for the first fetch">
      The repository has not been fetched yet. Open the Overview tab and choose Fetch now.
    </EmptyState>
  );
}

export const repositorySourceApi = (workspaceId: string, repositoryId: string) =>
  `/api/workspaces/${workspaceId}/repositories/${repositoryId}/source`;
