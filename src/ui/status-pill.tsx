const LABELS: Record<string, string> = {
  pending: 'Queued',
  syncing: 'Syncing',
  ready: 'Up to date',
  error: 'Sync failed',
  ok: 'Verified',
  failed: 'Test failed',
};

export function StatusPill({ status }: { status: string }) {
  return <span className={`pill ${status}`}>{LABELS[status] ?? status}</span>;
}
