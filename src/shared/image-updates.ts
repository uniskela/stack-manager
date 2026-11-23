import { isAlias, isMap, isScalar, isSeq, parseDocument } from 'yaml';

export type WudBinding = { watcher: string; project: string };

export interface WudObservation extends WudBinding {
  service: string;
  repository: string;
  installedTag: string;
  installedDigest: string | null;
  checkedAt: string | null;
  available: boolean;
  failed: boolean;
  candidateTag: string | null;
  changelogUrl?: string;
  digestOnly: boolean;
}

interface StackImage {
  name: string;
  image: string | null;
  excluded: boolean;
  editable: boolean;
}

export type ImageUpdateStatus =
  | 'available'
  | 'current'
  | 'digest'
  | 'excluded'
  | 'unsupported'
  | 'unbound'
  | 'unmatched'
  | 'drift'
  | 'stale'
  | 'error'
  | 'ambiguous';

export interface StackImageUpdate {
  name: string;
  image: string | null;
  status: ImageUpdateStatus;
  candidateTag: string | null;
  changelogUrl?: string;
  scanTimeUnavailable?: true;
}

const WATCH_LABELS = ['wud.watch', 'getwud.app/watch', 'wud/watch', 'wud.getwud.io/watch'];
const DOCKER_HUB_HOSTS = ['docker.io', 'index.docker.io', 'registry-1.docker.io', 'hub.docker.com'];
const TAG = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const IMAGE_PATH = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$/;
const REGISTRY = /^[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]{1,5})?$/;
export const WUD_OBSERVATION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function canonicalImageRepository(registry: string, path: string): string | null {
  const host = registry.toLowerCase();
  if (!REGISTRY.test(host) || path.length > 255 || !IMAGE_PATH.test(path)) return null;
  if (DOCKER_HUB_HOSTS.includes(host)) {
    return 'index.docker.io/' + (path.includes('/') ? path : 'library/' + path);
  }
  return host + '/' + path;
}

export function isImageTag(tag: string): boolean {
  return TAG.test(tag);
}

export function isImageDigest(digest: string): boolean {
  return DIGEST.test(digest);
}

export function imageReference(value: string) {
  const [raw, digest, extra] = value.split('@');
  if (!raw || extra !== undefined || (digest !== undefined && !isImageDigest(digest))) return null;
  const separator = raw.lastIndexOf(':');
  const hasTag = separator > raw.lastIndexOf('/');
  const name = hasTag ? raw.slice(0, separator) : raw;
  const tag = hasTag ? raw.slice(separator + 1) : digest ? null : 'latest';
  if (tag !== null && !isImageTag(tag)) return null;
  const slash = name.indexOf('/');
  const first = slash < 0 ? '' : name.slice(0, slash);
  const hasHost = first === 'localhost' || first.includes('.') || first.includes(':');
  const repository = canonicalImageRepository(
    hasHost ? first : 'docker.io',
    hasHost ? name.slice(slash + 1) : name,
  );
  return repository ? { repository, name, tag, digest, explicitTag: hasTag } : null;
}

export function inspectStackImages(text: string): StackImage[] | null {
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length > 0 || !isMap(doc.contents)) return null;
  const root = doc.contents;
  const services = root.get('services', true);
  if (!isMap(services)) return root.has('include') ? [] : null;
  return services.items.flatMap(({ key, value }) => {
    if (!isScalar(key) || typeof key.value !== 'string' || !isMap(value)) return [];
    const imageNode = value.get('image', true);
    const image = isScalar(imageNode) && typeof imageNode.value === 'string' ? imageNode.value : null;
    const resolveLabel = (node: unknown) => (isAlias(node) ? node.resolve(doc) : node);
    const labelsNode = value.get('labels', true);
    const labels = resolveLabel(labelsNode);
    const excluded = WATCH_LABELS.some((label) => {
      if (isMap(labels)) {
        const flag = resolveLabel(labels.get(label, true));
        return isScalar(flag) && String(flag.value).toLowerCase() === 'false';
      }
      return (
        isSeq(labels) &&
        labels.items
          .map(resolveLabel)
          .some(
            (item) =>
              isScalar(item) &&
              typeof item.value === 'string' &&
              item.value.toLowerCase() === label + '=false',
          )
      );
    });
    return [
      {
        name: key.value,
        image,
        excluded,
        editable:
          image !== null &&
          isScalar(imageNode) &&
          !imageNode.anchor &&
          !root.has('include') &&
          (!isAlias(labelsNode) || isMap(labels) || isSeq(labels)) &&
          (!isMap(labels) || !labels.has('<<')) &&
          !value.has('extends') &&
          !value.has('<<') &&
          !value.has('build') &&
          imageReference(image) !== null,
      },
    ];
  });
}

function statusFor(
  image: StackImage,
  bound: boolean,
  matches: WudObservation[],
  now: Date,
  staleSnapshot: boolean,
): Pick<StackImageUpdate, 'status' | 'candidateTag' | 'changelogUrl' | 'scanTimeUnavailable'> {
  const result = (status: ImageUpdateStatus, candidateTag: string | null = null) => ({
    status,
    candidateTag,
  });
  if (image.excluded) return result('excluded');
  const ref = image.editable && image.image ? imageReference(image.image) : null;
  if (!ref) return result('unsupported');
  if (!bound) return result('unbound');
  if (staleSnapshot) return result('stale');
  if (!matches.length) return result('unmatched');
  if (matches.some((row) => row.failed)) return result('error');
  if (
    matches.some((row) => {
      if (row.checkedAt === null) return false;
      const checkedAt = Date.parse(row.checkedAt);
      const age = now.getTime() - checkedAt;
      return !Number.isFinite(age) || age < -60_000 || age > WUD_OBSERVATION_MAX_AGE_MS;
    })
  )
    return result('stale');
  if (
    matches.some(
      (row) =>
        row.repository !== ref.repository ||
        (ref.tag !== null && row.installedTag !== ref.tag) ||
        (ref.digest !== undefined && row.installedDigest !== ref.digest),
    )
  )
    return result('drift');
  const first = matches[0]!;
  if (
    matches.some(
      (row) =>
        row.available !== first.available ||
        (row.available && (row.candidateTag !== first.candidateTag || row.digestOnly !== first.digestOnly)),
    )
  ) {
    return result('ambiguous');
  }
  const scanTime = matches.some((row) => row.checkedAt === null)
    ? { scanTimeUnavailable: true as const }
    : {};
  if (!first.available) return { ...result('current'), ...scanTime };
  if (first.digestOnly) return result('digest');
  if (!first.candidateTag || first.candidateTag === ref.tag) return result('error');
  if (ref.digest || !ref.explicitTag) return result('unsupported', first.candidateTag);
  const changelogUrl = first.changelogUrl;
  return {
    ...result('available', first.candidateTag),
    ...scanTime,
    ...(changelogUrl && matches.every((row) => row.changelogUrl === changelogUrl) ? { changelogUrl } : {}),
  };
}

export function matchImageUpdates(
  images: StackImage[],
  binding: WudBinding | null,
  observations: WudObservation[],
  now: Date,
  staleSnapshot: boolean,
): StackImageUpdate[] {
  const byService = new Map<string, WudObservation[]>();
  for (const row of observations) {
    if (row.watcher !== binding?.watcher || row.project !== binding.project) continue;
    const rows = byService.get(row.service) ?? [];
    rows.push(row);
    byService.set(row.service, rows);
  }
  return images.map((image) => ({
    name: image.name,
    image: image.image,
    ...statusFor(image, binding !== null, byService.get(image.name) ?? [], now, staleSnapshot),
  }));
}
