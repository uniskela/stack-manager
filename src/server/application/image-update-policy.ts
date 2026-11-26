import { parseDocument } from 'yaml';
import { z } from 'zod';
import { ValidationError } from '@/server/domain/errors';
import { parseGitAuthorIdentity } from '@/server/domain/user';
import { canonicalImageRepository } from '@/shared/image-updates';
import { normalizeRepoPath } from '@/shared/source/paths';

export const IMAGE_UPDATE_POLICY_PATH = '.stack-manager/image-updates.json';

const MAX_POLICY_BYTES = 64 * 1024;
const MAX_RULES = 100;
const MAX_URL_LENGTH = 2048;
const PLACEHOLDER = /\{\{(current|target)\}\}/g;
const HTTPS_AUTHORITY = /^https:\/\/([^/?#]+)/i;
const RELEASE_ANCHOR = /^#[\da-z][\da-z.-]{0,127}$/i;

export interface ImageUpdatePolicy {
  sources: { manual: boolean; wud: boolean };
  missingEvidence: 'review' | 'block';
  riskSignals: 'review' | 'block';
  respectWudOptOut: boolean;
  exclude: Array<{ path: string; service?: string }>;
  changelogs: Record<string, string>;
  serviceChangelogs: Array<{ path: string; service: string; url: string }>;
  automation?: z.infer<typeof automation>;
}

const path = z.string().refine((value) => {
  try {
    return normalizeRepoPath(value) === value;
  } catch {
    return false;
  }
});
const service = z
  .string()
  .max(255)
  .regex(/^[a-zA-Z0-9._-]+$/);
const imageName = z
  .string()
  .max(512)
  .refine((value) => {
    const slash = value.indexOf('/');
    const first = slash < 0 ? '' : value.slice(0, slash);
    const hasRegistry = first === 'localhost' || first.includes('.') || first.includes(':');
    return (
      canonicalImageRepository(
        hasRegistry ? first : 'docker.io',
        hasRegistry ? value.slice(slash + 1) : value,
      ) !== null
    );
  });

function changelogUrl(value: string): URL | null {
  if (value.length > MAX_URL_LENGTH || /[\s\p{Cc}\\?{}]/u.test(value)) return null;
  const hash = value.indexOf('#');
  if (hash !== -1 && !RELEASE_ANCHOR.test(value.slice(hash))) return null;
  const authority = HTTPS_AUTHORITY.exec(value)?.[1];
  if (!authority || authority.includes('@')) return null;
  return URL.parse(value);
}

function isChangelogTemplate(value: string): boolean {
  if (value.length > MAX_URL_LENGTH) return false;
  const authority = HTTPS_AUTHORITY.exec(value)?.[1];
  if (!authority || /[{}]/.test(authority)) return false;
  const hash = value.indexOf('#');
  const pathEnd = hash === -1 ? value.length : hash;
  const withTags = value.slice(0, pathEnd).replace(PLACEHOLDER, 'version') + value.slice(pathEnd);
  return changelogUrl(withTags) !== null;
}

const urlTemplate = z.string().refine(isChangelogTemplate);
const reviewRule = z.enum(['review', 'block']);
const changelogs = z.preprocess(
  (value) => {
    // Zod records discard this key before validating the repository name.
    if (value && typeof value === 'object' && Object.hasOwn(value, '__proto__')) return null;
    return value;
  },
  z.record(imageName, urlTemplate).refine((values) => Object.keys(values).length <= MAX_RULES),
);
const author = z.strictObject({ name: z.string(), email: z.string() }).transform(parseGitAuthorIdentity);
const automation = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('report'), author: author.optional() }),
  z.strictObject({ mode: z.literal('publish'), author }),
]);
const schema = z.strictObject({
  version: z.literal(1),
  sources: z.strictObject({ manual: z.boolean().optional(), wud: z.boolean().optional() }).optional(),
  missingEvidence: reviewRule.optional(),
  riskSignals: reviewRule.optional(),
  respectWudOptOut: z.boolean().optional(),
  exclude: z
    .array(z.strictObject({ path, service: service.optional() }))
    .max(MAX_RULES)
    .optional(),
  changelogs: changelogs.optional(),
  serviceChangelogs: z
    .array(z.strictObject({ path, service, url: urlTemplate }))
    .max(MAX_RULES)
    .optional(),
  automation: automation.optional(),
});

export function parseImageUpdatePolicy(text: string | null): ImageUpdatePolicy {
  let input: unknown = { version: 1 };
  if (text !== null) {
    if (text.length > MAX_POLICY_BYTES || Buffer.byteLength(text, 'utf8') > MAX_POLICY_BYTES) {
      throw new ValidationError('Repository image update policy is too large.');
    }
    try {
      input = JSON.parse(text);
    } catch {
      throw new ValidationError('Repository image update policy must be valid JSON.');
    }
    if (
      input &&
      typeof input === 'object' &&
      Object.hasOwn(input, 'automation') &&
      parseDocument(text, { schema: 'json', uniqueKeys: true, prettyErrors: false }).errors.length
    ) {
      throw new ValidationError('Repository image update automation cannot use duplicate fields.');
    }
  }
  const result = schema.safeParse(input);
  if (!result.success) throw new ValidationError('Repository image update policy has invalid fields.');

  const config = result.data;
  return {
    sources: { manual: config.sources?.manual ?? true, wud: config.sources?.wud ?? true },
    missingEvidence: config.missingEvidence ?? 'review',
    riskSignals: config.riskSignals ?? 'review',
    respectWudOptOut: config.respectWudOptOut ?? true,
    exclude: config.exclude ?? [],
    changelogs: config.changelogs ?? {},
    serviceChangelogs: config.serviceChangelogs ?? [],
    ...(config.automation ? { automation: config.automation } : {}),
  };
}

export function policyExcludes(policy: ImageUpdatePolicy, path: string, service: string): boolean {
  return policy.exclude.some(
    (rule) => rule.path === path && (rule.service === undefined || rule.service === service),
  );
}

export function resolvePolicyChangelog(
  policy: ImageUpdatePolicy,
  input: {
    path: string;
    service: string;
    image: string;
    repository: string;
    currentTag: string;
    targetTag: string;
    override?: string | null;
  },
): string | null {
  const serviceUrl = policy.serviceChangelogs.find(
    (rule) => rule.path === input.path && rule.service === input.service,
  )?.url;
  const urls = [
    input.override,
    serviceUrl,
    Object.hasOwn(policy.changelogs, input.image) ? policy.changelogs[input.image] : undefined,
    Object.hasOwn(policy.changelogs, input.repository) ? policy.changelogs[input.repository] : undefined,
  ];
  for (const template of urls) {
    if (!template || !isChangelogTemplate(template)) continue;
    try {
      const expanded = template.replace(PLACEHOLDER, (_match, field: string) => {
        const tag = field === 'current' ? input.currentTag : input.targetTag;
        if (tag === '.' || tag === '..') throw new URIError('An image tag cannot be a URL dot segment.');
        return encodeURIComponent(tag);
      });
      const url = changelogUrl(expanded);
      if (url) return url.href;
    } catch {
      // A tag that cannot be safely encoded cannot supply this changelog URL.
    }
  }
  return null;
}
