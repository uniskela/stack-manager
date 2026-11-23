import { isMap, isScalar, parseDocument, Scalar, type YAMLMap } from 'yaml';
import { imageReference, isImageTag } from '@/shared/image-updates';

interface ComposeImageChange {
  service: string;
  before: string;
  after: string;
  currentTag: string;
  targetTag: string;
}

class ImageEditError extends Error {}

function isDirectMap(node: unknown): node is YAMLMap {
  return (
    isMap(node) &&
    !node.anchor &&
    !node.tag &&
    node.items.every(
      ({ key }) => isScalar(key) && !key.anchor && !key.tag && key.source !== '<<' && key.value !== '<<',
    )
  );
}

function imageValueRange(text: string, image: Scalar, before: string): [number, number] {
  if (!image.range) throw new ImageEditError('The image scalar is missing a source range.');
  const [start, end] = image.range;
  switch (image.type) {
    case Scalar.PLAIN:
      return [start, end];
    case Scalar.QUOTE_SINGLE:
    case Scalar.QUOTE_DOUBLE:
      return [start + 1, end - 1];
    case Scalar.BLOCK_FOLDED:
    case Scalar.BLOCK_LITERAL: {
      // A valid image in a block scalar fits on one content line below the header.
      const contentStart = text.indexOf('\n', start) + 1;
      const valueStart = text.indexOf(before, contentStart);
      if (contentStart > start && valueStart >= contentStart && valueStart + before.length <= end) {
        return [valueStart, valueStart + before.length];
      }
    }
  }
  throw new ImageEditError('The image scalar cannot be edited safely.');
}

function planImageEdit(text: string, services: YAMLMap, service: string, targetTag: string) {
  const node = services.get(service, true);
  if (!isDirectMap(node) || node.has('build') || node.has('extends')) {
    throw new ImageEditError('The selected service needs a direct image definition.');
  }

  const image = node.get('image', true);
  if (!isScalar(image) || image.anchor || image.tag || typeof image.value !== 'string') {
    throw new ImageEditError('The selected service needs an unanchored literal image.');
  }

  const before = image.value;
  const ref = imageReference(before);
  if (!ref?.tag || ref.digest) {
    throw new ImageEditError('The selected service needs a valid, unpinned image reference.');
  }
  const { tag: currentTag, explicitTag: hasTag } = ref;
  if (currentTag === targetTag) throw new ImageEditError('The target tag matches the current tag.');

  const name = hasTag ? before.slice(0, before.lastIndexOf(':')) : before;
  const after = `${name}:${targetTag}`;
  const change = { service, before, after, currentTag, targetTag };
  const [start, end] = imageValueRange(text, image, before);
  if (!hasTag) return { change, start: end, end, replacement: `:${targetTag}` };

  const valueSource = text.slice(start, end);
  if (valueSource.endsWith(`:${currentTag}`)) {
    return { change, start: end - currentTag.length, end, replacement: targetTag };
  }
  if (image.type === Scalar.QUOTE_DOUBLE && !/[\r\n]/.test(valueSource)) {
    // An escape in the tag or separator can require replacing the entire quoted value.
    return { change, start, end, replacement: after };
  }
  throw new ImageEditError('The image scalar cannot be edited safely.');
}

export function editComposeImages(
  text: string,
  edits: readonly { service: string; targetTag: string }[],
): { content: string; changes: ComposeImageChange[]; failures: { service: string; reason: string }[] } {
  const doc = parseDocument(text, { prettyErrors: false, uniqueKeys: true });
  const root = doc.contents;
  if (doc.errors.length || !isDirectMap(root) || root.has('include')) {
    throw new Error('Image edits require a valid Compose document without includes or merges.');
  }
  const services = root.get('services', true);
  if (!isDirectMap(services)) throw new Error('Image edits require a direct services mapping.');

  const seen = new Set<string>();
  const failures = new Map<string, string>();
  for (const { service, targetTag } of edits) {
    if (seen.has(service)) failures.set(service, 'Select each service only once.');
    else if (!isImageTag(targetTag)) failures.set(service, 'The target tag is invalid.');
    seen.add(service);
  }
  const patches: ReturnType<typeof planImageEdit>[] = [];
  for (const { service, targetTag } of edits) {
    if (failures.has(service)) continue;
    try {
      patches.push(planImageEdit(text, services, service, targetTag));
    } catch (error) {
      const reason = error instanceof ImageEditError ? error.message : 'The image cannot be edited safely.';
      failures.set(service, reason);
    }
  }

  const changes = patches.map(({ change }) => change);
  let offset = 0;
  const orderedPatches = patches.toSorted((a, b) => a.start - b.start);
  const content = orderedPatches.map(({ start, end, replacement }) => {
    const part = text.slice(offset, start) + replacement;
    offset = end;
    return part;
  });
  content.push(text.slice(offset));
  return {
    content: content.join(''),
    changes,
    failures: [...failures].map(([service, reason]) => ({ service, reason })),
  };
}
