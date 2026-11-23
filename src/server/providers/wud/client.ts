import { z } from 'zod';
import {
  canonicalImageRepository,
  isImageDigest,
  isImageTag,
  type WudObservation,
} from '@/shared/image-updates';
import { AppError, ValidationError } from '@/server/domain/errors';
import { safeChangelogUrl } from '@/server/providers/changelog/reader';
import { readHttps } from '@/server/security/https-read';
import type { Resolver } from '@/server/security/network-policy';

export const WUD_IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
export const WUD_TOKEN = /^[\x21-\x7e]{1,4096}$/;

const observation = z.object({
  watcher: z.string().regex(WUD_IDENTIFIER),
  labels: z.object({
    'com.docker.compose.project': z.string().regex(WUD_IDENTIFIER),
    'com.docker.compose.service': z.string().regex(WUD_IDENTIFIER),
  }),
  image: z.object({
    registry: z.object({ url: z.string().max(512) }),
    name: z.string().max(255),
    tag: z.object({ value: z.string().refine(isImageTag) }),
    digest: z.object({ repo: z.string().nullable().optional() }).nullish(),
  }),
  checkedAt: z.string().max(64).nullish(),
  updateAvailable: z.boolean(),
  updateKind: z.object({ kind: z.string().max(16) }).nullish(),
  result: z
    .object({ tag: z.string().refine(isImageTag).nullish(), changelogUrl: z.string().max(2048).nullish() })
    .nullish(),
  error: z.unknown().optional(),
});

function registryHost(raw: string): string | null {
  try {
    const url = new URL(raw.includes('://') ? raw : 'https://' + raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      return null;
    return url.host;
  } catch {
    return null;
  }
}

export function normalizeWudObservations(raw: unknown): WudObservation[] {
  if (!Array.isArray(raw) || raw.length > 10_000) throw new Error('WUD returned an invalid snapshot');
  return raw.flatMap((entry) => {
    const candidate = observation.safeParse(entry);
    if (!candidate.success) return [];
    const row = candidate.data;
    const host = registryHost(row.image.registry.url);
    const repository = host && canonicalImageRepository(host, row.image.name);
    if (!repository) return [];
    const digest = row.image.digest?.repo;
    const checkedAt = Date.parse(row.checkedAt ?? '');
    const changelogUrl = row.result?.changelogUrl && safeChangelogUrl(row.result.changelogUrl);
    return [
      {
        watcher: row.watcher,
        project: row.labels['com.docker.compose.project'],
        service: row.labels['com.docker.compose.service'],
        repository,
        installedTag: row.image.tag.value,
        installedDigest: digest && isImageDigest(digest) ? digest : null,
        checkedAt: Number.isFinite(checkedAt) ? new Date(checkedAt).toISOString() : null,
        available: row.updateAvailable,
        candidateTag: row.result?.tag ?? null,
        ...(changelogUrl ? { changelogUrl } : {}),
        digestOnly: row.updateKind?.kind === 'digest',
        failed: row.error !== undefined && row.error !== null,
      },
    ];
  });
}

export function wudBaseUrl(raw: string): string {
  const message = 'Use an HTTPS WUD URL without credentials, a query string, or a fragment.';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ValidationError(message);
  }
  if (url.protocol !== 'https:' || url.username || url.password || /[\x00-\x20\x7f?#]/.test(raw))
    throw new ValidationError(message);
  return url.href.replace(/\/+$/, '');
}

export class WudClient {
  constructor(private readonly options: { allowPrivateNetworks: boolean; resolver?: Resolver }) {}

  async read(baseUrl: string, token: string, signal?: AbortSignal): Promise<WudObservation[]> {
    const url = new URL(wudBaseUrl(baseUrl) + '/api/containers');
    if (!WUD_TOKEN.test(token)) throw new ValidationError('Invalid WUD token.');
    const timeout = AbortSignal.timeout(10_000);
    try {
      const { status, body } = await readHttps(url, {
        ...this.options,
        headers: { Accept: 'application/json', Authorization: 'Bearer ' + token },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        maxBytes: 8 * 1024 * 1024,
      });
      if (status === 401 || status === 403)
        throw new AppError(502, 'wud_auth_failed', 'WUD refused the read token.');
      if (status !== 200) throw new Error('Unexpected response');
      return normalizeWudObservations(JSON.parse(body.toString('utf8')));
    } catch (error) {
      if (error instanceof AppError && error.code === 'wud_auth_failed') throw error;
      throw new AppError(
        502,
        'wud_unavailable',
        'Unable to read the WUD snapshot. Check its URL, network policy and availability.',
      );
    }
  }
}
