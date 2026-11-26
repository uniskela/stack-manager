import { z } from 'zod';
import { AppError, ConflictError, ValidationError } from '@/server/domain/errors';
import { normalizeRemoteUrl, validateBranchName } from '@/server/domain/git-repository';
import { readHttps } from '@/server/security/https-read';
import type { Resolver } from '@/server/security/network-policy';

const PAGE_LIMIT = 50;
const MAX_PAGES = 20;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export type GiteaImageUpdatePull = {
  number: number;
  url: string;
  head: string;
  headSha: string;
  base: string;
  title: string;
  sameRepository?: boolean;
  draft?: boolean;
  mergeable?: boolean;
};

export type GiteaImageUpdatePullInput = { remoteUrl: string; token: string; signal?: AbortSignal };
export type GiteaGetImageUpdatePullInput = GiteaImageUpdatePullInput & { number: number };
export type GiteaCreateImageUpdatePullInput = GiteaImageUpdatePullInput & {
  head: string;
  base: string;
  title: string;
  body: string;
};
export type GiteaImageUpdateChecks = 'success' | 'pending' | 'failure' | 'missing';
export type GiteaImageUpdateChecksInput = GiteaImageUpdatePullInput & { headSha: string };
export type GiteaMergeImageUpdatePullInput = GiteaImageUpdateChecksInput & { number: number };

const branch = z.object({ ref: z.string(), repo_id: z.number().int().optional() });
const pull = z.object({
  number: z.number().int().positive(),
  state: z.literal('open').optional(),
  title: z.string().min(1).max(1024),
  draft: z.boolean().optional(),
  mergeable: z.boolean().optional(),
  head: branch.extend({ sha: z.string().regex(OBJECT_ID), label: z.string().optional() }),
  base: branch,
});
const pullState = z.object({ number: z.number().int().positive(), state: z.enum(['open', 'closed']) });
const combinedStatus = z.object({
  sha: z.string().regex(OBJECT_ID),
  total_count: z.number().int().nonnegative().optional(),
  statuses: z
    .array(
      z.object({
        status: z.enum(['success', 'pending', 'failure', 'error', 'warning', 'skipped']),
        context: z.string(),
      }),
    )
    .max(PAGE_LIMIT)
    .nullable(),
});

type HttpsResponse = Awaited<ReturnType<typeof readHttps>>;

function invalidResponse() {
  return new AppError(502, 'forge_invalid_response', 'Gitea returned an invalid API response.');
}

function rejectedRequest() {
  return new AppError(502, 'forge_request_failed', 'Gitea rejected the API request.');
}

function readJson(response: HttpsResponse, okStatus = 200): unknown {
  if (response.status !== okStatus) throw rejectedRequest();
  try {
    return JSON.parse(response.body.toString('utf8'));
  } catch {
    throw invalidResponse();
  }
}

function repositoryUrls(raw: string): { api: string; web: string } {
  const clone = new URL(normalizeRemoteUrl(raw));
  const segments = clone.pathname.slice(1).split('/').map(decodeURIComponent);
  const repository = segments.pop()?.replace(/\.git$/i, '');
  const owner = segments.pop();
  if (
    !repository ||
    !owner ||
    ![...segments, owner, repository].every((segment) => /^[A-Za-z0-9._~-]+$/.test(segment))
  ) {
    throw new ValidationError('Use a Gitea HTTPS clone URL with an owner and repository.');
  }
  const prefix = segments.length ? '/' + segments.join('/') : '';
  return {
    api: `${clone.origin}${prefix}/api/v1/repos/${owner}/${repository}`,
    web: `${clone.origin}${prefix}/${owner}/${repository}/pulls`,
  };
}

function responseBranch(ref: string): string {
  const name = ref.replace(/^refs\/heads\//, '');
  try {
    if (validateBranchName(name) === name) return name;
  } catch {
    // Forge-supplied validation details stay out of the operator-facing error.
  }
  throw invalidResponse();
}

function normalizePull(raw: unknown, web: string): GiteaImageUpdatePull {
  const parsed = pull.safeParse(raw);
  if (!parsed.success) throw invalidResponse();
  const row = parsed.data;
  const syntheticHead = row.head.ref === `refs/pull/${row.number}/head`;
  return {
    number: row.number,
    url: `${web}/${row.number}`,
    head: responseBranch((syntheticHead && row.head.label) || row.head.ref),
    headSha: row.head.sha,
    base: responseBranch(row.base.ref),
    title: row.title,
    ...(row.draft === undefined ? {} : { draft: row.draft }),
    ...(row.mergeable === undefined ? {} : { mergeable: row.mergeable }),
    ...(row.head.repo_id !== undefined && row.base.repo_id !== undefined
      ? { sameRepository: !syntheticHead && row.base.repo_id > 0 && row.head.repo_id === row.base.repo_id }
      : {}),
  };
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function pageUrl(endpoint: string, page: number, filters: Record<string, string> = {}): URL {
  const url = new URL(endpoint);
  url.search = new URLSearchParams({ ...filters, page: String(page), limit: String(PAGE_LIMIT) }).toString();
  return url;
}

export class GiteaImageUpdatePulls {
  constructor(
    private readonly options: {
      allowPrivateNetworks: boolean;
      resolver?: Resolver;
      request?: typeof readHttps;
    },
  ) {}

  async get(input: GiteaGetImageUpdatePullInput): Promise<GiteaImageUpdatePull | null> {
    const { api, web } = repositoryUrls(input.remoteUrl);
    if (!Number.isSafeInteger(input.number) || input.number <= 0) {
      throw new ValidationError('Provide the pull request number.');
    }
    const response = await this.request(
      new URL(`${api}/pulls/${input.number}`),
      input.token,
      requestSignal(input.signal),
    );
    if (response.status === 404) return null;
    const raw = readJson(response);
    const parsed = pullState.safeParse(raw);
    if (!parsed.success || parsed.data.number !== input.number) throw invalidResponse();
    return parsed.data.state === 'closed' ? null : normalizePull(raw, web);
  }

  async list(input: GiteaImageUpdatePullInput): Promise<GiteaImageUpdatePull[]> {
    const { api, web } = repositoryUrls(input.remoteUrl);
    const signal = requestSignal(input.signal);
    const seen = new Set<number>();
    const result: GiteaImageUpdatePull[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const url = pageUrl(api + '/pulls', page, { state: 'open', sort: 'oldest' });
      const response = readJson(await this.request(url, input.token, signal));
      if (!Array.isArray(response) || response.length > PAGE_LIMIT) throw invalidResponse();
      // A server can cap the requested page size. Keep paging until an empty page confirms the end.
      if (response.length === 0) return result;
      for (const raw of response) {
        const row = normalizePull(raw, web);
        if (seen.has(row.number)) throw invalidResponse();
        seen.add(row.number);
        result.push(row);
      }
    }
    throw new AppError(
      502,
      'forge_list_incomplete',
      'Unable to verify the complete list of open Gitea pull requests.',
    );
  }

  async create(input: GiteaCreateImageUpdatePullInput): Promise<GiteaImageUpdatePull> {
    const { api, web } = repositoryUrls(input.remoteUrl);
    const { head, base, title, body } = input;
    if (
      head === base ||
      validateBranchName(head, 'head') !== head ||
      validateBranchName(base, 'base') !== base ||
      !title.trim() ||
      title.length > 255 ||
      /[\r\n\u0000]/.test(title) ||
      Buffer.byteLength(body) > 128 * 1024
    ) {
      throw new ValidationError('Invalid Gitea pull request head, base, title or body.');
    }
    const response = await this.request(
      new URL(api + '/pulls'),
      input.token,
      requestSignal(input.signal),
      JSON.stringify({ head, base, title, body }),
    );
    if (response.status === 409) {
      throw new ConflictError(
        'Gitea rejected the pull request because it conflicts with an existing request.',
      );
    }
    const created = normalizePull(readJson(response, 201), web);
    if (created.head !== head || created.base !== base || created.sameRepository === false) {
      throw invalidResponse();
    }
    return created;
  }

  async checks(input: GiteaImageUpdateChecksInput): Promise<GiteaImageUpdateChecks> {
    const { api } = repositoryUrls(input.remoteUrl);
    const { headSha } = input;
    if (!OBJECT_ID.test(headSha)) throw new ValidationError('Provide the full pull request head commit SHA.');
    const signal = requestSignal(input.signal);
    const endpoint = `${api}/commits/${headSha}/status`;
    const contexts = new Set<string>();
    let failed = false;
    let pending = false;
    let skipped = false;
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const response = await this.request(pageUrl(endpoint, page), input.token, signal);
      if (page === 1 && response.status === 404) return 'missing';
      // Gitea's combined state and total_count describe the current page only.
      const parsed = combinedStatus.safeParse(readJson(response));
      if (!parsed.success || parsed.data.sha !== headSha) throw invalidResponse();
      const statuses = parsed.data.statuses ?? [];
      if (parsed.data.total_count !== undefined && parsed.data.total_count !== statuses.length) {
        throw invalidResponse();
      }
      if (statuses.length === 0) {
        if (failed) return 'failure';
        if (pending) return 'pending';
        return contexts.size === 0 || skipped ? 'missing' : 'success';
      }
      for (const { context, status } of statuses) {
        if (contexts.has(context)) throw invalidResponse();
        contexts.add(context);
        failed ||= status === 'failure' || status === 'error' || status === 'warning';
        pending ||= status === 'pending';
        skipped ||= status === 'skipped';
      }
    }
    throw new AppError(502, 'forge_checks_incomplete', 'Unable to verify the complete list of Gitea checks.');
  }

  async merge(input: GiteaMergeImageUpdatePullInput): Promise<void> {
    const { api } = repositoryUrls(input.remoteUrl);
    const { headSha, number } = input;
    if (!Number.isSafeInteger(number) || number <= 0 || !OBJECT_ID.test(headSha)) {
      throw new ValidationError('Provide the pull request number and full head commit SHA.');
    }
    const response = await this.request(
      new URL(`${api}/pulls/${number}/merge`),
      input.token,
      requestSignal(input.signal),
      JSON.stringify({
        do: 'merge',
        head_commit_id: headSha,
        force_merge: false,
        merge_when_checks_succeed: false,
        delete_branch_after_merge: false,
      }),
    );
    if ([404, 405, 409, 422].includes(response.status)) {
      throw new ConflictError(
        'Gitea could not merge this pull request at the checked head. Refresh it and review its merge requirements.',
      );
    }
    if (response.status !== 200 && response.status !== 204) throw rejectedRequest();
  }

  private async request(
    url: URL,
    token: string,
    signal: AbortSignal,
    payload?: string,
  ): Promise<HttpsResponse> {
    if (!/^[\x21-\x7e]{1,4096}$/.test(token)) throw new ValidationError('Invalid Gitea token.');
    const request = this.options.request ?? readHttps;
    const headers: Record<string, string> = { Accept: 'application/json', Authorization: 'token ' + token };
    if (payload !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(payload));
    }
    let response: HttpsResponse;
    try {
      response = await request(url, {
        allowPrivateNetworks: this.options.allowPrivateNetworks,
        resolver: this.options.resolver,
        signal,
        maxBytes: MAX_RESPONSE_BYTES,
        headers,
        ...(payload === undefined ? {} : { method: 'POST', body: payload }),
      });
    } catch {
      throw new AppError(502, 'forge_unavailable', 'Unable to contact the Gitea pull request API.');
    }
    if (response.status === 401 || response.status === 403) {
      throw new AppError(502, 'forge_auth_failed', 'Gitea refused access to the pull request API.');
    }
    return response;
  }
}
