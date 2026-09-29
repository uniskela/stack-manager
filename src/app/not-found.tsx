import { FileQuestion } from 'lucide-react';
import { Brand } from '@/ui/brand';
import { ButtonLink } from '@/ui/primitives/button';
import { EmptyState } from '@/ui/primitives/empty-state';

export default function NotFound() {
  return (
    <main className="center-shell">
      <div className="auth-card">
        <Brand />
        <EmptyState
          icon={FileQuestion}
          headingLevel={1}
          title="Page not found"
          actions={<ButtonLink href="/">Go home</ButtonLink>}
        >
          That page does not exist, or you do not have access to it.
        </EmptyState>
      </div>
    </main>
  );
}
