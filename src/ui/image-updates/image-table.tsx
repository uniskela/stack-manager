import type { ImageUpdateStatus, StackImageUpdate } from '@/shared/image-updates';
import { TableWrap } from '@/ui/primitives/table-wrap';

const labels: Record<ImageUpdateStatus, string> = {
  available: 'WUD found a newer tag',
  current: 'WUD found no newer tag',
  digest: 'Image rebuilt under the same tag',
  excluded: 'Ignored by this service’s WUD label',
  unsupported: 'Image reference needs manual review',
  unbound: 'Link this stack to WUD to check for updates',
  unmatched: 'WUD did not report this service',
  drift: 'Deployed image differs from Git',
  stale: 'WUD data is out of date',
  error: 'WUD could not check this image',
  ambiguous: 'Running copies report different updates',
};

export function ImageUpdateTable({
  labelledBy,
  images,
  connected = true,
}: Readonly<{ labelledBy: string; images: readonly StackImageUpdate[]; connected?: boolean }>) {
  return (
    <TableWrap labelledBy={labelledBy}>
      <table className="simple">
        <thead>
          <tr>
            <th scope="col">Compose service</th>
            <th scope="col">Image saved in Git</th>
            {connected ? <th scope="col">Suggested tag from WUD</th> : null}
            {connected ? <th scope="col">Update status</th> : null}
          </tr>
        </thead>
        <tbody>
          {images.map((image) => (
            <tr key={image.name}>
              <th scope="row">{image.name}</th>
              <td>{image.image ? <code>{image.image}</code> : '—'}</td>
              {connected ? <td>{image.candidateTag ? <code>{image.candidateTag}</code> : '—'}</td> : null}
              {connected ? (
                <td>
                  <span className={image.status === 'available' ? 'pill ok' : undefined}>
                    {labels[image.status]}
                  </span>
                  {image.scanTimeUnavailable ? (
                    <div className="fine-print">WUD scan time unavailable</div>
                  ) : null}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}
