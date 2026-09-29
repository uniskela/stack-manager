'use client';

import { TriangleAlert } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { startTransition } from 'react';
import { Button, ButtonLink } from './primitives/button';
import { EmptyState } from './primitives/empty-state';

/**
 * Body of the route error boundaries. Shows only the opaque digest (which matches the server log entry),
 * never the error message, which could contain provider or path details.
 */
export function ErrorPanel({ digest, reset }: { digest?: string; reset: () => void }) {
  const router = useRouter();
  return (
    <EmptyState
      icon={TriangleAlert}
      headingLevel={1}
      title="Something went wrong"
      actions={
        <>
          <Button
            variant="primary"
            onClick={() =>
              startTransition(() => {
                router.refresh();
                reset();
              })
            }
          >
            Try again
          </Button>
          <ButtonLink href="/">Go home</ButtonLink>
        </>
      }
    >
      This page could not be loaded. Nothing was changed.
      {digest ? (
        <>
          {' '}
          Reference: <span className="mono">{digest}</span>
        </>
      ) : null}
    </EmptyState>
  );
}
