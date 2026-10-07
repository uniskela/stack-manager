import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as stackHistory from '@/app/api/workspaces/[workspaceId]/stacks/[stackId]/history/route';
import * as stackDetail from '@/app/api/workspaces/[workspaceId]/stacks/[stackId]/history/[sha]/route';
import * as repoHistory from '@/app/api/workspaces/[workspaceId]/repositories/[repositoryId]/history/route';
import * as repoDetail from '@/app/api/workspaces/[workspaceId]/repositories/[repositoryId]/history/[sha]/route';
import * as setup from '@/app/api/setup/route';
import { GitCli } from '@/server/providers/git/git-cli';
import { GitOperationError } from '@/server/providers/git/types';
import type { HistoryPage, HistoryDetail } from '@/shared/git-history';
import { createHarness, type TestHarness } from '../support/container';
import { gitServerOverrides, startGitServer, type GitServer } from '../support/git-server';
import { call, cookieFrom } from '../support/http';

const REPO = 'acme/history.git';
const COMPOSE = 'services:\n  app:\n    image: nginx:1.27\n';
let server: GitServer;
let h: TestHarness;
let cookie: string;
let workspaceId: string;
let repositoryId: string;
let target: string;
let other: string;
let root: string;
let initial: string;
let onlyOther: string;
let multiple: string;
let shared: string;
let deleted: string;
let renamed: string;
let nested: string;
let locked: string;

beforeAll(async () => {
  server = await startGitServer();
  server.createRepo(REPO);
  initial = server.commitFiles(REPO, 'main', {
    'apps/wiki/compose.yaml': COMPOSE,
    'apps/wiki/old.md': 'old\n',
    'apps/notes/compose.yaml': COMPOSE,
    'apps/wiki/nested/compose.yaml': COMPOSE,
    'README.md': '# Repository\n',
  });
  onlyOther = server.commitFiles(REPO, 'main', { 'apps/notes/README.md': 'notes\n' });
  multiple = server.commitFiles(REPO, 'main', {
    'apps/wiki/compose.yaml': COMPOSE + '# update\n',
    'apps/wiki/README.md': 'wiki\n',
    'apps/wiki2/README.md': 'prefix sibling\n',
  });
  shared = server.commitFiles(REPO, 'main', {
    'apps/wiki/README.md': 'shared wiki\n',
    'apps/notes/README.md': 'shared notes\n',
    'shared/proxy.conf': 'outside stack roots\n',
  });
  deleted = server.commitFiles(REPO, 'main', { 'apps/wiki/old.md': null });
  renamed = server.commitFiles(REPO, 'main', {
    'apps/wiki/README.md': null,
    'apps/wiki/renamed.md': 'shared wiki\n',
  });
  nested = server.commitFiles(REPO, 'main', { 'apps/wiki/nested/settings.json': '{"enabled":true}\n' });
  locked = server.commitFiles(REPO, 'main', {
    'apps/wiki/.env': 'PASSWORD=history-secret-marker\n',
    'apps/wiki/secrets/key.txt': 'history-secret-marker\n',
    'apps/wiki/link': { symlink: '/etc/passwd' },
    'apps/wiki/binary.dat': 'binary\0data',
    'apps/wiki/large.txt': 'x'.repeat(256 * 1024 + 1),
  });
});
afterAll(async () => server.close());

beforeEach(async () => {
  h = await createHarness({ overrides: gitServerOverrides(server) });
  const admin = await call(setup.POST, {
    method: 'POST',
    body: { username: 'admin', password: 'correct horse battery staple' },
  });
  cookie = cookieFrom(admin);
  workspaceId = (await h.container.workspaces.create({ name: 'Homelab' }, admin.json.user.id)).id;
  repositoryId = (
    await h.container.repositories.create(
      workspaceId,
      {
        gitProviderType: 'github',
        remoteUrl: `https://git.test/${REPO}`,
        autoAddStacks: false,
        auth: { type: 'none' },
      },
      admin.json.user.id,
    )
  ).id;
  await h.container.repositories.sync(repositoryId);
  await h.container.repos.gitRepositories.update(repositoryId, { headSha: locked, updatedAt: new Date() });
  target = (
    await h.container.stacks.create(
      workspaceId,
      repositoryId,
      { name: 'Display name unrelated to path', rootPath: 'apps/wiki' },
      admin.json.user.id,
    )
  ).id;
  other = (
    await h.container.stacks.create(
      workspaceId,
      repositoryId,
      { name: 'Wiki', rootPath: 'apps/notes' },
      admin.json.user.id,
    )
  ).id;
  root = (await h.container.stacks.create(workspaceId, repositoryId, { rootPath: '' }, admin.json.user.id))
    .id;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await h.cleanup();
});

async function list(stackId = target, query = '') {
  return call(stackHistory.GET, { cookie, params: { workspaceId, stackId }, path: `/history${query}` });
}
async function detail(sha: string, stackId = target) {
  return call(stackDetail.GET, { cookie, params: { workspaceId, stackId, sha } });
}

describe('stack-scoped history API', () => {
  it('uses actual paths, includes multiple relevant files and shared commits, excludes sibling stacks', async () => {
    const res = await list();
    expect(res.status).toBe(200);
    const page = res.json as HistoryPage;
    expect(page).toMatchObject({ repositoryId, rootPath: 'apps/wiki', headSha: locked, nextCursor: null });
    expect(page.commits.map((c) => c.sha)).toEqual([
      locked,
      nested,
      renamed,
      deleted,
      shared,
      multiple,
      initial,
    ]);
    expect(page.commits.map((c) => c.sha)).not.toContain(onlyOther);
    expect(page.commits.find((c) => c.sha === multiple)?.files.map((f) => f.path)).toEqual([
      'apps/wiki/README.md',
      'apps/wiki/compose.yaml',
    ]);
    expect(page.commits[0]).toMatchObject({
      shortSha: locked.slice(0, 7),
      author: { name: 'Test', email: 'test@example.invalid' },
      subject: 'update files',
    });
    expect(page.commits[0]?.committedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const notes = (await list(other)).json as HistoryPage;
    expect(notes.commits.map((c) => c.sha)).toEqual([shared, onlyOther, initial]);
    expect(notes.commits.find((c) => c.sha === shared)?.files).toEqual([
      { path: 'apps/notes/README.md', status: 'modified' },
    ]);
  });

  it('root stacks and repository history share the whole repository contract', async () => {
    const stack = await list(root);
    const repo = await call(repoHistory.GET, { cookie, params: { workspaceId, repositoryId } });
    expect(repo.status).toBe(200);
    expect(repo.json).toEqual(stack.json);
    expect(repo.json.commits.map((c: { sha: string }) => c.sha)).toContain(onlyOther);
    expect(repo.json.commits.find((c: { sha: string }) => c.sha === shared).files).toHaveLength(3);
    const rootCommit = repo.json.commits.at(-1);
    const result = await call(repoDetail.GET, {
      cookie,
      params: { workspaceId, repositoryId, sha: rootCommit.sha },
    });
    expect(result.status).toBe(200);
    expect(result.json.commit.diffBaseSha).toBeNull();
    expect(result.json.commit.files[0]).toMatchObject({ status: 'added', locked: null });
  });

  it('scopes nested stack paths without including parent-only changes', async () => {
    const stack = await h.container.stacks.create(
      workspaceId,
      repositoryId,
      { rootPath: 'apps/wiki/nested' },
      'test-admin',
    );
    const page = (await list(stack.id)).json as HistoryPage;
    expect(page.commits.map((c) => c.sha)).toEqual([nested, initial]);
    expect(page.commits.flatMap((c) => c.files).every((f) => f.path.startsWith('apps/wiki/nested/'))).toBe(
      true,
    );
  });

  it('returns scoped structured diffs for additions, multiple files, deletions and rename sides', async () => {
    const multi = (await detail(multiple)).json as HistoryDetail;
    expect(multi.commit.files).toHaveLength(2);
    expect(multi.commit.files.flatMap((f) => f.hunks?.flatMap((hunk) => hunk.lines) ?? [])).toContain(
      '+# update',
    );
    const deletion = await detail(deleted);
    expect(deletion.status).toBe(200);
    expect(deletion.json.commit.files[0]).toMatchObject({
      path: 'apps/wiki/old.md',
      status: 'deleted',
      locked: null,
    });
    expect(deletion.json.commit.files[0].hunks[0].lines).toContain('-old');
    const rename = (await detail(renamed)).json as HistoryDetail;
    expect(rename.commit.files.map(({ path, status }) => ({ path, status }))).toEqual([
      { path: 'apps/wiki/README.md', status: 'deleted' },
      { path: 'apps/wiki/renamed.md', status: 'added' },
    ]);
    const sharedResult = (await detail(shared)).json as HistoryDetail;
    expect(sharedResult.commit.files.map((f) => f.path)).toEqual(['apps/wiki/README.md']);
  });

  it('never returns secret, symlink, binary or oversized content in detail', async () => {
    const result = await detail(locked);
    expect(result.status).toBe(200);
    const files = (result.json as HistoryDetail).commit.files;
    expect(Object.fromEntries(files.map((f) => [f.path, f.locked]))).toEqual({
      'apps/wiki/.env': 'secret',
      'apps/wiki/secrets/key.txt': 'secret',
      'apps/wiki/link': 'symlink',
      'apps/wiki/binary.dat': 'binary',
      'apps/wiki/large.txt': 'too_large',
    });
    expect(files.every((f) => f.hunks === null)).toBe(true);
    expect(result.text).not.toContain('history-secret-marker');
    expect(result.text).not.toContain('/etc/passwd');
  });

  it('paginates without duplication and keeps the original snapshot after a new fetch', async () => {
    const first = (await list(target, '?limit=2')).json as HistoryPage;
    expect(first.commits.map((c) => c.sha)).toEqual([locked, nested]);
    expect(first.nextCursor).toBeTypeOf('string');
    const head = server.commitFiles(REPO, 'main', { 'apps/wiki/fetched.md': 'new\n' });
    await h.container.repositories.sync(repositoryId);
    const second = (await list(target, `?cursor=${first.nextCursor}`)).json as HistoryPage;
    expect(second.headSha).toBe(locked);
    expect(second.commits.map((c) => c.sha)).toEqual([renamed, deleted]);
    let cursor = second.nextCursor;
    const shas = [...first.commits, ...second.commits].map((c) => c.sha);
    while (cursor) {
      const page = (await list(target, `?cursor=${cursor}`)).json as HistoryPage;
      shas.push(...page.commits.map((c) => c.sha));
      cursor = page.nextCursor;
    }
    expect(shas).toEqual([locked, nested, renamed, deleted, shared, multiple, initial]);
    expect((await list()).json.headSha).toBe(head);
    // Later tests must use the original fixture snapshot, while leaving remote objects intact.
  });

  it('returns empty history for a scope with no commits', async () => {
    const page = await h.container.gitHistory.list(workspaceId, repositoryId, 'never/existed');
    expect(page.commits).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it('reports stale history anchors after a rewind', async () => {
    const first = (await list(target, '?limit=2')).json as HistoryPage;
    await h.container.repos.gitRepositories.update(repositoryId, { headSha: initial, updatedAt: new Date() });
    const result = await list(target, `?cursor=${first.nextCursor}`);
    expect(result.status).toBe(409);
    expect(result.json.error.code).toBe('history_changed');
  });

  it('caps returned files, aggregate content and expensive diffs', async () => {
    const files: Record<string, string> = { 'apps/wiki/a0-diff-limit.txt': 'added\n'.repeat(12_000) };
    for (let i = 0; i < 6; i++) files[`apps/wiki/a1-budget-${i}.txt`] = 'x'.repeat(200 * 1024);
    for (let i = 0; i < 101; i++) files[`apps/wiki/z-${i}.txt`] = 'small\n';
    const sha = server.commitFiles(REPO, 'main', files);
    await h.container.repositories.sync(repositoryId);
    const summary = (await list()).json.commits[0];
    expect(summary.files).toHaveLength(100);
    expect(summary.filesTruncated).toBe(true);
    const result = (await detail(sha)).json as HistoryDetail;
    expect(result.commit.files).toHaveLength(100);
    expect(result.commit.filesTruncated).toBe(true);
    expect(result.commit.files.find((f) => f.path.endsWith('a0-diff-limit.txt'))?.locked).toBe('diff_limit');
    expect(result.commit.files.find((f) => f.path.endsWith('a1-budget-5.txt'))?.locked).toBe('too_large');
  });

  it('keeps unusual Git filenames as locked metadata without blocking normal file diffs', async () => {
    const names = ['apps/wiki/trailing ', 'apps/wiki/back\\slash', 'apps/wiki/new\nline'];
    const files = Object.fromEntries(names.map((name) => [name, 'unsupported-path-marker\n']));
    files['apps/wiki/ordinary.txt'] = 'ordinary\n';
    const sha = server.commitFiles(REPO, 'main', files);
    await h.container.repositories.sync(repositoryId);
    expect((await list()).json.commits[0].sha).toBe(sha);
    const result = await detail(sha);
    expect(result.status).toBe(200);
    for (const name of names) {
      expect((result.json as HistoryDetail).commit.files.find((f) => f.path === name)).toMatchObject({
        locked: 'unsupported_path',
        hunks: null,
      });
    }
    expect(result.text).not.toContain('unsupported-path-marker');
    expect(
      result.json.commit.files.find((f: { path: string }) => f.path === 'apps/wiki/ordinary.txt').hunks[0]
        .lines,
    ).toContain('+ordinary');
  });

  it('reports the pagination ceiling without constructing an unusable cursor', async () => {
    const providers = await import('@/server/providers/git/history-reader');
    const first = (await list(target, '?limit=2')).json as HistoryPage;
    const cursor = JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString());
    cursor.offset = 10_000;
    vi.spyOn(providers.GitHistoryReader.prototype, 'listCommits').mockResolvedValue({
      shas: [locked],
      hasMore: true,
    });
    const result = await list(target, `?cursor=${Buffer.from(JSON.stringify(cursor)).toString('base64url')}`);
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({ nextCursor: null, historyLimitReached: true });
  });

  it('validates pages, cursors, full SHAs, reachability and stack membership', async () => {
    for (const query of [
      '?limit=0',
      '?limit=51',
      '?limit=-1',
      '?limit=1.5',
      '?limit=1&limit=2',
      '?cursor=',
      '?cursor=bad',
      '?path=apps/notes',
    ]) {
      expect((await list(target, query)).status, query).toBe(400);
    }
    const cursor = (await list(target, '?limit=2')).json.nextCursor;
    expect((await list(other, `?cursor=${cursor}`)).status).toBe(400);
    expect((await list(target, `?cursor=${cursor}&limit=3`)).status).toBe(400);
    expect((await detail('--all')).status).toBe(400);
    expect((await detail('a'.repeat(40))).status).toBe(404);
    expect((await detail(onlyOther)).status).toBe(404);
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString());
    decoded.offset = 10_001;
    const oversized = Buffer.from(JSON.stringify(decoded)).toString('base64url');
    expect((await list(target, `?cursor=${oversized}`)).status).toBe(400);
  });

  it('enforces authentication and workspace access and requires a fetched snapshot', async () => {
    expect((await call(stackHistory.GET, { params: { workspaceId, stackId: target } })).status).toBe(401);
    expect(
      (await call(stackDetail.GET, { params: { workspaceId, stackId: target, sha: shared } })).status,
    ).toBe(401);
    expect((await call(repoHistory.GET, { params: { workspaceId, repositoryId } })).status).toBe(401);
    expect((await call(repoDetail.GET, { params: { workspaceId, repositoryId, sha: shared } })).status).toBe(
      401,
    );
    expect(
      (await call(stackHistory.GET, { cookie, params: { workspaceId: 'another', stackId: target } })).status,
    ).toBe(404);
    expect(
      (await call(repoHistory.GET, { cookie, params: { workspaceId: 'another', repositoryId } })).status,
    ).toBe(404);
    await h.container.repos.gitRepositories.update(repositoryId, { headSha: null, updatedAt: new Date() });
    expect((await list()).json.error.code).toBe('not_synced');
    expect((await detail(shared)).status).toBe(409);
  });

  it('handles arbitrary message delimiters, Unicode and markup as JSON text', async () => {
    const source = (await h.container.repositories.localSource(workspaceId, repositoryId))!;
    const cli = new GitCli({ homeDir: path.join(h.dataDir, 'git-home') });
    const tree = (await cli.run(['rev-parse', `${multiple}^{tree}`], { cwd: source.cloneDir })).stdout.trim();
    const message = 'Unicode café 日本語 <script>alert(1)</script>\n\nBody\u001e with delimiter\n%x00 %H';
    const sha = (
      await cli.run(
        [
          '-c',
          'user.name=Test',
          '-c',
          'user.email=test@example.invalid',
          'commit-tree',
          tree,
          '-p',
          onlyOther,
          '-m',
          message,
        ],
        { cwd: source.cloneDir },
      )
    ).stdout.trim();
    await h.container.repos.gitRepositories.update(repositoryId, { headSha: sha, updatedAt: new Date() });
    const result = await detail(sha);
    expect(result.status).toBe(200);
    expect(result.json.commit.message).toBe(message + '\n');
    expect(result.json.commit.subject).toBe('Unicode café 日本語 <script>alert(1)</script>');
    expect(result.headers.get('content-type')).toContain('application/json');
    expect(h.logs.join('\n')).not.toContain(message);
    const blob = (
      await cli.run(['rev-parse', `${sha}:apps/wiki/compose.yaml`], { cwd: source.cloneDir })
    ).stdout.trim();
    expect((await detail(blob)).status).toBe(404);
  });

  it('maps provider errors to a safe envelope without exposing raw Git stderr', async () => {
    const providers = await import('@/server/providers/git/history-reader');
    vi.spyOn(providers.GitHistoryReader.prototype, 'listCommits').mockRejectedValue(
      new GitOperationError('invalid', 'raw secret provider output'),
    );
    const result = await list();
    expect(result.status).toBe(502);
    expect(result.json.error.code).toBe('git_history_failed');
    expect(result.text + h.logs.join('\n')).not.toContain('raw secret provider output');
  });
});
