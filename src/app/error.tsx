'use client';

import { ErrorPanel } from '@/ui/error-panel';

export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="center-shell">
      <div className="auth-card">
        <ErrorPanel digest={error.digest} reset={reset} />
      </div>
    </main>
  );
}
