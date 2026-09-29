'use client';

import { ErrorPanel } from '@/ui/error-panel';

/** Keeps the workspace shell (and its navigation) on screen when a page fails. */
export default function WorkspaceError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorPanel digest={error.digest} reset={reset} />;
}
