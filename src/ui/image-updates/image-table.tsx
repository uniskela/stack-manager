import type { ImageUpdateStatus, StackImageUpdate } from '@/shared/image-updates';
import { TableWrap } from '@/ui/primitives/table-wrap';

const labels: Record<ImageUpdateStatus, string> = {
  available: 'Update available',
  current: 'No update reported',
  digest: 'Same-tag rebuild',
  excluded: 'WUD opt-out in Compose',
  unsupported: 'Requires manual inspection',
  unbound: 'No active WUD mapping',
  unmatched: 'Not reported by WUD',
  drift: 'Deployed image differs from Git',
  stale: 'WUD observation is old or unavailable',
  error: 'WUD check failed or returned an invalid candidate',
  ambiguous: 'WUD replicas disagree',
};

export function ImageUpdateTable({
  labelledBy,
  images,
}: Readonly<{ labelledBy: string; images: readonly StackImageUpdate[] }>) {
  return (
    <TableWrap labelledBy={labelledBy}>
      <table className="simple">
        <thead>
          <tr>
            <th scope="col">Service</th>
            <th scope="col">Image in Git</th>
            <th scope="col">Candidate tag</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {images.map((image) => (
            <tr key={image.name}>
              <th scope="row">{image.name}</th>
              <td>{image.image ? <code>{image.image}</code> : '—'}</td>
              <td>{image.candidateTag ? <code>{image.candidateTag}</code> : '—'}</td>
              <td>
                <span className={image.status === 'available' ? 'pill ok' : undefined}>
                  {labels[image.status]}
                </span>
                {image.scanTimeUnavailable ? (
                  <div className="fine-print">WUD scan time unavailable</div>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}
