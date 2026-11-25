import Link from 'next/link';
import type { WudBinding } from '@/shared/image-updates';
import { WudBindingForm } from './forms';
import { WudMappingDiscovery } from './mapping-discovery';

export function StackWudMatch({
  workspaceId,
  stackId,
  binding,
}: Readonly<{ workspaceId: string; stackId: string; binding: WudBinding | null }>) {
  return (
    <div className="stack">
      {binding ? (
        <p>
          Using WUD project <code>{binding.project}</code> on Docker host <code>{binding.watcher}</code>.
        </p>
      ) : (
        <>
          <p className="muted">
            Find the running Compose project that matches this stack’s services and images.
          </p>
          <WudMappingDiscovery workspaceId={workspaceId} stackId={stackId} labelledBy="wud-mapping" />
          <p>
            <Link href={`/w/${workspaceId}/stacks/image-updates#wud-matches`}>Match all stacks</Link>
          </p>
        </>
      )}
      <details className="narrow">
        <summary>{binding ? 'Edit WUD match' : 'Enter WUD details manually'}</summary>
        <WudBindingForm
          key={binding ? binding.watcher + ':' + binding.project : 'unbound'}
          workspaceId={workspaceId}
          stackId={stackId}
          binding={binding}
        />
      </details>
    </div>
  );
}
