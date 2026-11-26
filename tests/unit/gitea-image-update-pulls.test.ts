import { describe, expect, it, vi } from 'vitest';
import { GiteaImageUpdatePulls } from '@/server/providers/git/gitea-image-update-pulls';
import type { readHttps } from '@/server/security/https-read';

const remoteUrl = 'https://forge.example.test:8443/services/git/org/infra.git';
const token = 'fixture-token';
const input = { remoteUrl, token };
const head = 'stack-manager/image-updates/beszel';
const base = 'main';
const headSha = '0123456789012345678901234567890123456789';
const title = 'WIP: Update Beszel';
const origin = 'https://forge.example.test:8443';
const apiPath = '/services/git/api/v1/repos/org/infra/pulls';

function pull(number: number) {
  return {
    number,
    title,
    state: 'open',
    html_url: 'https://untrusted.example.test/pr',
    head: { ref: `refs/heads/${head}`, sha: headSha, repo_id: 5 },
    base: { ref: `refs/heads/${base}`, repo_id: 5 },
  };
}

function response(payload: unknown, status = 200) {
  return { status, body: Buffer.from(JSON.stringify(payload), 'utf8') };
}

function adapter(request = vi.fn<typeof readHttps>()) {
  return { request, pulls: new GiteaImageUpdatePulls({ allowPrivateNetworks: false, request }) };
}

describe('Gitea image update pull requests', () => {
  it('lists through the original HTTPS forge subpath until the first empty page', async () => {
    const { pulls, request } = adapter();
    request
      .mockResolvedValueOnce(response([pull(1)]))
      .mockResolvedValueOnce(response([pull(2)]))
      .mockResolvedValueOnce(response([]));

    const rows = await pulls.list(input);
    expect(rows).toEqual(
      [1, 2].map((number) => ({
        number,
        title,
        head,
        base,
        headSha,
        sameRepository: true,
        url: `${origin}/services/git/org/infra/pulls/${number}`,
      })),
    );
    expect(
      request.mock.calls.map(([url]) => [url.origin, url.pathname, url.searchParams.get('page')]),
    ).toEqual([1, 2, 3].map((page) => [origin, apiPath, String(page)]));
    const [url, options] = request.mock.calls[0]!;
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ state: 'open', limit: '50' });
    expect(options).toMatchObject({
      headers: { Authorization: `token ${token}` },
      allowPrivateNetworks: false,
    });
    expect(url.href).not.toContain(token);
  });

  it('identifies an open pull request from a fork with the same branch name', async () => {
    const { pulls, request } = adapter();
    const row = pull(1);
    row.head.repo_id = 9;
    request.mockResolvedValueOnce(response([row])).mockResolvedValueOnce(response([]));
    await expect(pulls.list(input)).resolves.toMatchObject([{ head, sameRepository: false }]);
  });

  it('reads the branch label when Gitea can only resolve its synthetic pull ref', async () => {
    const { pulls, request } = adapter();
    const row = pull(17);
    row.head = { ...row.head, repo_id: -1, ref: 'refs/pull/17/head' };
    const hidden = { ...row, head: { ...row.head, label: head } };
    request.mockResolvedValueOnce(response([hidden])).mockResolvedValueOnce(response([]));
    await expect(pulls.list(input)).resolves.toMatchObject([{ number: 17, head, sameRepository: false }]);
  });

  it('creates one draft using the documented POST fields', async () => {
    const { pulls, request } = adapter();
    request.mockResolvedValue(response(pull(3), 201));
    const body = 'Preview for Beszel → 0.21.2';
    await expect(pulls.create({ ...input, head, base, title, body })).resolves.toMatchObject({
      number: 3,
      headSha,
      title,
    });
    expect(request).toHaveBeenCalledOnce();
    const [url, options] = request.mock.calls[0]!;
    expect(url.href).toBe(origin + apiPath);
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body!)).toEqual({ head, base, title, body });
    expect(options.headers['Content-Length']).toBe(String(Buffer.byteLength(options.body!)));
  });

  it('does not accept a created pull request for a different head branch', async () => {
    const { pulls, request } = adapter();
    const row = pull(3);
    row.head.ref = 'other';
    request.mockResolvedValue(response(row, 201));
    await expect(pulls.create({ ...input, head, base, title, body: '' })).rejects.toMatchObject({
      status: 502,
    });
  });

  it('gets and verifies the exact current PR with its draft and mergeable flags', async () => {
    const { pulls, request } = adapter();
    request.mockResolvedValueOnce(response({ ...pull(6), draft: true, mergeable: false }));
    await expect(pulls.get({ ...input, number: 6 })).resolves.toMatchObject({
      number: 6,
      draft: true,
      mergeable: false,
    });
    expect(request.mock.calls[0]?.[0].href).toBe(`${origin}${apiPath}/6`);
  });

  it('returns no reviewable PR when the exact PR is closed or absent', async () => {
    const { pulls, request } = adapter();
    request
      .mockResolvedValueOnce(response({ ...pull(6), state: 'closed' }))
      .mockResolvedValueOnce(response({}, 404));
    await expect(pulls.get({ ...input, number: 6 })).resolves.toBeNull();
    await expect(pulls.get({ ...input, number: 7 })).resolves.toBeNull();
  });

  it('signals a mismatched PR number as an invalid response', async () => {
    const { pulls, request } = adapter();
    request.mockResolvedValueOnce(response(pull(7)));
    await expect(pulls.get({ ...input, number: 6 })).rejects.toMatchObject({ status: 502 });
  });

  it.each([
    [[], 'missing'],
    [['success'], 'success'],
    [['success', 'pending'], 'pending'],
    [['pending', 'error'], 'failure'],
    [['success', 'skipped'], 'missing'],
  ] as const)('reports the check state for %j', async (states, expected) => {
    const { pulls, request } = adapter();
    const statuses = states.map((status, index) => ({ status, context: `ci/step-${index}` }));
    request
      .mockResolvedValueOnce(response({ sha: headSha, statuses }))
      .mockResolvedValueOnce(response({ sha: headSha, statuses: [] }));

    await expect(pulls.checks({ ...input, headSha })).resolves.toBe(expected);
    const [url] = request.mock.calls[0]!;
    expect(url.origin).toBe(origin);
    expect(url.pathname).toBe(`/services/git/api/v1/repos/org/infra/commits/${headSha}/status`);
  });

  it('includes a failing check from a later page when computing verified status', async () => {
    const { pulls, request } = adapter();
    request
      .mockResolvedValueOnce(
        response({ sha: headSha, statuses: [{ status: 'success', context: 'ci/unit' }] }),
      )
      .mockResolvedValueOnce(
        response({ sha: headSha, statuses: [{ status: 'failure', context: 'ci/build' }] }),
      )
      .mockResolvedValueOnce(response({ sha: headSha, statuses: [] }));
    await expect(pulls.checks({ ...input, headSha })).resolves.toBe('failure');
  });

  it('treats missing combined status as unverified', async () => {
    const { pulls, request } = adapter();
    request.mockResolvedValueOnce(response({}, 404));
    await expect(pulls.checks({ ...input, headSha })).resolves.toBe('missing');
  });

  it('recognizes Gitea’s null status list when the commit has no checks', async () => {
    const { pulls, request } = adapter();
    request.mockResolvedValueOnce(
      response({ sha: headSha, total_count: 0, state: 'pending', statuses: null }),
    );
    await expect(pulls.checks({ ...input, headSha })).resolves.toBe('missing');
  });

  it('rejects a response that omits status records it claims to have', async () => {
    const { pulls, request } = adapter();
    request.mockResolvedValueOnce(response({ sha: headSha, total_count: 4, statuses: null }));
    await expect(pulls.checks({ ...input, headSha })).rejects.toMatchObject({ status: 502 });
  });

  it('rejects status evidence for a different commit', async () => {
    const { pulls, request } = adapter();
    request.mockResolvedValueOnce(
      response({ sha: 'f'.repeat(40), statuses: [{ status: 'success', context: 'ci/test' }] }),
    );
    await expect(pulls.checks({ ...input, headSha })).rejects.toMatchObject({ status: 502 });
  });

  it('merges one exact pull request at the checked head without forcing or scheduling', async () => {
    const { pulls, request } = adapter();
    request.mockResolvedValueOnce({ status: 200, body: Buffer.alloc(0) });
    await expect(pulls.merge({ ...input, number: 17, headSha })).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledOnce();
    const [url, options] = request.mock.calls[0]!;
    expect(url.href).toBe(`${origin}${apiPath}/17/merge`);
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body!)).toMatchObject({
      head_commit_id: headSha,
      force_merge: false,
      merge_when_checks_succeed: false,
    });
  });

  it.each([405, 409, 422])('leaves PR status %s as a conflict without retry', async (status) => {
    const { pulls, request } = adapter();
    request.mockResolvedValueOnce(response({ message: token }, status));
    await expect(pulls.merge({ ...input, number: 17, headSha })).rejects.toMatchObject({ status: 409 });
    expect(request).toHaveBeenCalledOnce();
  });

  it('does not report HTTP 201 as confirmation that the merge completed', async () => {
    const { pulls, request } = adapter();
    request.mockResolvedValueOnce(response({}, 201));
    await expect(pulls.merge({ ...input, number: 17, headSha })).rejects.toMatchObject({ status: 502 });
  });

  it('rejects invalid selectors without contacting Gitea', async () => {
    const { pulls, request } = adapter();
    await expect(pulls.merge({ ...input, number: 0, headSha })).rejects.toMatchObject({ status: 400 });
    await expect(pulls.merge({ ...input, number: 1, headSha: 'main' })).rejects.toMatchObject({
      status: 400,
    });
    await expect(pulls.checks({ ...input, headSha: 'main' })).rejects.toMatchObject({ status: 400 });
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    'http://forge.example.test/org/infra.git',
    'https://user:secret@forge.example.test/org/infra.git',
    'https://forge.example.test/org%2Finfra.git',
    'https://forge.example.test/org%252Finfra/infra.git',
    'https://forge.example.test/org/infra.git?token=secret',
  ])('rejects invalid clone URL %s before any request', async (invalid) => {
    const { pulls, request } = adapter();
    await expect(pulls.list({ ...input, remoteUrl: invalid })).rejects.toMatchObject({ status: 400 });
    expect(request).not.toHaveBeenCalled();
  });

  it('fails closed on a list that repeats a prior page', async () => {
    const { pulls, request } = adapter();
    request.mockResolvedValue(response([pull(1)]));
    await expect(pulls.list(input)).rejects.toMatchObject({ status: 502 });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('fails closed when the open list exceeds the page budget', async () => {
    const { pulls, request } = adapter();
    request.mockImplementation(async (url) => response([pull(Number(url.searchParams.get('page')))]));
    await expect(pulls.list(input)).rejects.toMatchObject({ status: 502 });
    expect(request).toHaveBeenCalledTimes(20);
  });

  it.each([302, 401, 403, 404, 429, 503])(
    'rejects status %s without exposing the response',
    async (status) => {
      const { pulls, request } = adapter();
      request.mockResolvedValue(response({ error: token }, status));
      await expect(pulls.list(input)).rejects.not.toThrow(token);
      expect(request).toHaveBeenCalledOnce();
    },
  );

  it('uses the existing network policy before sending authentication', async () => {
    const resolver = vi.fn().mockResolvedValue(['10.2.3.4']);
    const pulls = new GiteaImageUpdatePulls({ allowPrivateNetworks: false, resolver });
    await expect(pulls.list(input)).rejects.toMatchObject({ status: 502 });
    expect(resolver).toHaveBeenCalledWith('forge.example.test');
  });
});
