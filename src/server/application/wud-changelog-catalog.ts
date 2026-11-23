import { z } from 'zod';
import { safeChangelogUrl } from '@/server/providers/changelog/reader';

export const WUD_CHANGELOG_CATALOG_PATH = 'docs/container-changelogs.json';

const catalog = z.object({
  sources: z.record(
    z.string(),
    z.object({ displayUrl: z.string().max(2048).optional(), url: z.string().max(2048).optional() }),
  ),
});

type Catalog = z.infer<typeof catalog>['sources'];

export function readWudChangelogCatalog(text: string | null): Catalog | null {
  if (!text || Buffer.byteLength(text) > 128 * 1024) return null;
  try {
    return catalog.safeParse(JSON.parse(text)).data?.sources ?? null;
  } catch {
    return null;
  }
}

/** Resolve published links for review. The legacy gate also uses its own release/mapping evidence. */
export function wudChangelogLink(
  sources: Catalog | null,
  input: {
    image: string;
    repository: string;
    currentTag: string;
    targetTag: string;
  },
): string | null {
  if (!sources) return null;
  const alias = (image: string) => image.replace(/^(?:index\.docker\.io|docker\.io|ghcr\.io)\//, '');
  const { image, repository, currentTag, targetTag } = input;
  const key = [image, alias(image), alias(repository)].find((candidate) => Object.hasOwn(sources, candidate));
  if (!key) return null;
  const entry = sources[key];
  const raw = entry?.displayUrl ?? entry?.url;
  const authority = raw?.match(/^https:\/\/([^/?#]+)/i)?.[1];
  if (!raw || !authority || /[{}]/.test(authority)) return null;
  const substitutions = {
    current_tag: currentTag,
    target_tag: targetTag,
    target_tag_canary_suffix: targetTag.startsWith('canary-') ? targetTag.slice(7) + '-canary' : targetTag,
    target_tag_stripped_version: targetTag.replace(/^version-/, ''),
    target_tag_stripped_slim: targetTag.replace(/-slim$/, ''),
  };
  const expanded = raw.replace(/\{([a-z_]+)\}/g, (placeholder, key: string) =>
    Object.hasOwn(substitutions, key)
      ? encodeURIComponent(substitutions[key as keyof typeof substitutions])
      : placeholder,
  );
  return /[{}]/.test(expanded) ? null : safeChangelogUrl(expanded);
}
