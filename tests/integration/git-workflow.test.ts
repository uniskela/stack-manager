import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as statusRoute from '@/app/api/workspaces/[workspaceId]/repositories/[repositoryId]/git/route';
import * as commitRoute from '@/app/api/workspaces/[workspaceId]/repositories/[repositoryId]/git/commit/route';
import * as pushRoute from '@/app/api/workspaces/[workspaceId]/repositories/[repositoryId]/git/push/route';
import * as setup from '@/app/api/setup/route';
import { GitCli } from '@/server/providers/git/git-cli';
import { GitOperationError } from '@/server/providers/git/types';
import { createHarness, type TestHarness } from '../support/container';
import { gitServerOverrides, startGitServer, type GitServer } from '../support/git-server';
import { call, cookieFrom } from '../support/http';

const REPO = 'acme/workflow.git';
const REMOTE = `https://git.test/${REPO}`;
const TOKEN = 'workflow-test-0123456789abcdef';
const AUTHOR = { name: 'Stack Operator', email: 'operator@example.invalid' };
const COMPOSE = 'services:\n  app:\n    image: nginx:1.27\n';
let server: GitServer;
let h: TestHarness;
let cookie: string;
let workspaceId: string;
let repositoryId: string;
let actorUserId: string;
let headSha: string;

beforeEach(async () => {
  server = await startGitServer({ token: TOKEN });
  server.createRepo(REPO);
  server.commitFiles(REPO, 'main', { 'README.md': '# Stacks\n', 'stack.yaml': COMPOSE });
  h = await createHarness({
    overrides: gitServerOverrides(server),
    env: { STACK_MANAGER_GIT_AUTHOR_NAME: AUTHOR.name, STACK_MANAGER_GIT_AUTHOR_EMAIL: AUTHOR.email },
  });
  const admin = await call(setup.POST, {
    method: 'POST',
    body: { username: 'admin', password: 'correct horse battery staple' },
  });
  cookie = cookieFrom(admin);
  actorUserId = admin.json.user.id;
  workspaceId = (await h.container.workspaces.create({ name: 'Homelab' }, actorUserId)).id;
  repositoryId = (
    await h.container.repositories.create(
      workspaceId,
      {
        gitProviderType: 'gitea',
        remoteUrl: REMOTE,
        autoAddStacks: false,
        auth: { type: 'token', token: TOKEN },
      },
      actorUserId,
    )
  ).id;
  await h.container.repositories.sync(repositoryId);
  headSha = (await h.container.repositories.localSource(workspaceId, repositoryId))!.commitSha;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await h.cleanup();
  await server.close();
});

const params = () => ({ workspaceId, repositoryId });
const commit = (body: unknown = { paths: ['compose.yaml'], message: 'Update stack' }) =>
  call(commitRoute.POST, { method: 'POST', cookie, params: params(), body });
const push = (commitSha: string, expectedRemoteSha = headSha) =>
  call(pushRoute.POST, { method: 'POST', cookie, params: params(), body: { commitSha, expectedRemoteSha } });
const provider = () => h.container.gitProviders.get('gitea');
const drafts = () => h.container.repos.drafts.list(repositoryId);
async function save(file = 'compose.yaml', content = COMPOSE + '# draft\n') {
  const view = await h.container.source.readFile(workspaceId, repositoryId, '', file).catch(() => null);
  return h.container.source.saveDraft(
    workspaceId,
    repositoryId,
    '',
    {
      path: file,
      content,
      baseBlobSha: view?.blobSha ?? null,
    },
    actorUserId,
  );
}
async function git(args: string[]) {
  const cli = new GitCli({
    homeDir: path.join(h.dataDir, 'git-home'),
    ...{
      allowedProtocols: gitServerOverrides(server).gitAllowedProtocols,
      extraConfig: gitServerOverrides(server).gitExtraConfig,
    },
  });
  const source = (await h.container.repositories.localSource(workspaceId, repositoryId))!;
  return (await cli.run(args, { cwd: source.cloneDir })).stdout;
}

describe('draft commit and safe push workflow', () => {
  it('commits selected drafts with the configured identity and preserves unselected work', async () => {
    await save();
    await save('README.md', '# Unselected\n');
    const before = await drafts();
    const result = await commit();
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({
      status: 'commit_succeeded',
      repositoryId,
      branch: 'main',
      draftsPreserved: true,
    });
    const sha = result.json.commitSha;
    expect(await git(['diff-tree', '--no-commit-id', '--name-only', '-r', sha])).toBe('compose.yaml\n');
    expect(await git(['show', `${sha}:README.md`])).toBe('# Stacks\n');
    const source = (await h.container.repositories.localSource(workspaceId, repositoryId))!;
    expect(await provider().getCommit(source.cloneDir, sha)).toMatchObject({
      author: AUTHOR,
      parents: [headSha],
    });
    expect(await drafts()).toEqual(before);
    const audit = await h.container.audit.list({ workspaceId });
    expect(audit.find((a) => a.action === 'git.commit')).toMatchObject({
      outcome: 'success',
      actorUserId,
      entityId: repositoryId,
      meta: { repositoryId, commitSha: sha, branch: 'main', changedFileCount: 1 },
    });
  });

  it('commits and pushes through real authenticated Git and records both audit events', async () => {
    await save();
    const before = await drafts();
    const result = await commit({ paths: ['compose.yaml'], message: 'Update stack', push: true });
    expect(result.status).toBe(200);
    expect(result.json.status).toBe('push_succeeded');
    const status = await call(statusRoute.GET, { cookie, params: params() });
    expect(status.json.state).toMatchObject({
      localHeadSha: result.json.commitSha,
      remoteHeadSha: result.json.commitSha,
      ahead: 0,
      behind: 0,
    });
    expect(await drafts()).toEqual(before);
    expect(
      (await h.container.audit.list({ workspaceId }))
        .filter((a) => a.action.startsWith('git.'))
        .map((a) => a.action)
        .sort(),
    ).toEqual(['git.commit', 'git.push']);
  });

  it('pushes a retained local commit separately and permits a safe retry', async () => {
    await save();
    const result = await commit();
    expect((await push(result.json.commitSha)).json.status).toBe('push_succeeded');
    expect((await push(result.json.commitSha, result.json.commitSha)).json.status).toBe('push_succeeded');
  });

  it('reports a changed remote SHA even when the remote contains the retained local head', async () => {
    await save();
    const committed = await commit();
    expect((await push(committed.json.commitSha)).json.status).toBe('push_succeeded');
    const result = await push(committed.json.commitSha);
    expect(result.status).toBe(409);
    expect(result.json).toMatchObject({
      status: 'remote_changed',
      commitSha: committed.json.commitSha,
      expectedRemoteSha: headSha,
      state: { localHeadSha: committed.json.commitSha, remoteHeadSha: committed.json.commitSha, behind: 0 },
    });
    expect(
      (await h.container.audit.list({ workspaceId })).find((a) => a.action === 'git.push_rejected'),
    ).toMatchObject({ meta: { reason: 'remote_changed' } });
  });

  it('preserves a newer draft saved while the selected snapshot is being committed', async () => {
    await save();
    const original = provider().commit.bind(provider());
    vi.spyOn(provider(), 'commit').mockImplementationOnce(async (input) => {
      await save('compose.yaml', COMPOSE + '# newer saved work\n');
      return original(input);
    });
    const result = await commit({ paths: ['compose.yaml'], message: 'Update', push: true });
    expect(result.json.status).toBe('push_succeeded');
    expect(await git(['show', `${result.json.commitSha}:compose.yaml`])).toBe(COMPOSE + '# draft\n');
    expect((await drafts())[0]!.content).toBe(COMPOSE + '# newer saved work\n');
  });

  it('retains push context when resolving credentials fails before provider invocation', async () => {
    await save();
    const committed = await commit();
    vi.spyOn(h.container.credentials, 'withPlaintext').mockRejectedValueOnce(new Error(TOKEN));
    const result = await push(committed.json.commitSha);
    expect(result.json).toMatchObject({
      status: 'git_operation_failed',
      operation: 'push',
      commitSha: committed.json.commitSha,
    });
    expect(result.text).not.toContain(TOKEN);
    expect(await drafts()).toHaveLength(1);
  });

  it('distinguishes superseded local commits and remote changes during separate push requests', async () => {
    await save();
    await save('README.md', '# Next\n');
    const first = await commit();
    const second = await commit({ paths: ['README.md'], message: 'Next' });
    const superseded = await push(first.json.commitSha);
    expect(superseded.json).toMatchObject({
      status: 'branch_changed',
      commitSha: first.json.commitSha,
      state: { localHeadSha: second.json.commitSha },
    });
    const remote = server.commit(REPO, 'main', 'README.md', '# Remote\n');
    const changed = await push(second.json.commitSha);
    expect(changed.json).toMatchObject({
      status: 'remote_changed',
      commitSha: second.json.commitSha,
      state: { remoteHeadSha: remote, behind: 1 },
    });
    expect(await drafts()).toHaveLength(2);
  });

  it.each([
    { paths: [], message: 'Update' },
    { paths: ['compose.yaml', 'compose.yaml'], message: 'Update' },
    { paths: ['../outside'], message: 'Update' },
    { paths: ['/compose.yaml'], message: 'Update' },
    { paths: ['.env'], message: 'Update' },
    { paths: ['missing.md'], message: 'Update' },
    { paths: ['compose.yaml'], message: ' ' },
    { paths: 'compose.yaml', message: 'Update' },
    { paths: ['compose.yaml'], message: 'Update', force: true },
  ])('rejects malformed selection/input %j without changing work', async (body) => {
    await save();
    const before = await drafts();
    expect((await commit(body)).status).toBe(400);
    expect(await drafts()).toEqual(before);
    expect((await call(statusRoute.GET, { cookie, params: params() })).json.state.localHeadSha).toBe(headSha);
  });

  it('blocks an outdated draft after fetching a changed source blob', async () => {
    await save();
    const before = await drafts();
    server.commit(REPO, 'main', 'compose.yaml', COMPOSE + '# upstream\n');
    await h.container.repositories.sync(repositoryId);
    const result = await commit();
    expect(result.status).toBe(409);
    expect(result.json).toMatchObject({
      status: 'draft_outdated',
      outdatedPaths: ['compose.yaml'],
      commitSha: null,
    });
    expect(await drafts()).toEqual(before);
  });

  it('validates the retained local tree on successive commits and refuses already committed drafts', async () => {
    await save();
    await save('README.md', '# Next\n');
    const first = await commit();
    expect((await commit()).json.status).toBe('draft_outdated');
    const next = await commit({ paths: ['README.md'], message: 'Next file' });
    expect(next.json.status).toBe('commit_succeeded');
    expect(await git(['rev-parse', `${next.json.commitSha}^`])).toBe(first.json.commitSha + '\n');
    expect(await drafts()).toHaveLength(2);
  });

  it('blocks validation errors even with warning acknowledgement', async () => {
    await save('compose.yaml', 'services:\n  app: {}\n');
    const before = await drafts();
    const result = await commit({ paths: ['compose.yaml'], message: 'Update', acknowledgeWarnings: true });
    expect(result.status).toBe(422);
    expect(result.json).toMatchObject({ status: 'validation_blocked', commitSha: null });
    expect(result.json.problems).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'compose.yaml', severity: 'error', line: 2 })]),
    );
    expect(await drafts()).toEqual(before);
  });

  it('uses registered Compose paths and validates only the selected commit contents', async () => {
    await h.container.stacks.create(
      workspaceId,
      repositoryId,
      { rootPath: '', composePath: 'stack.yaml' },
      actorUserId,
    );
    await save('stack.yaml', 'services:\n  app: {}\n');
    await save('README.md', '# Selected\n');
    expect((await commit({ paths: ['stack.yaml'], message: 'Update' })).json.status).toBe(
      'validation_blocked',
    );
    expect((await commit({ paths: ['README.md'], message: 'Docs' })).json.status).toBe('commit_succeeded');
  });

  it('requires explicit warning acknowledgement and audits the successful override safely', async () => {
    await save('compose.yaml', COMPOSE + '    environment:\n      PASSWORD: private-draft-value\n');
    const blocked = await commit();
    expect(blocked.status).toBe(422);
    expect(blocked.json.status).toBe('warnings_unacknowledged');
    const result = await commit({ paths: ['compose.yaml'], message: 'Update', acknowledgeWarnings: true });
    expect(result.json.status).toBe('commit_succeeded');
    const audit = (await h.container.audit.list({ workspaceId })).filter((a) => a.action.startsWith('git.'));
    expect(audit.find((a) => a.action === 'git.commit_validation_overridden')).toMatchObject({
      meta: { warningCount: 1, commitSha: result.json.commitSha },
    });
    expect(JSON.stringify(audit) + blocked.text + result.text).not.toContain('private-draft-value');
  });

  it('reports missing identity without creating a commit', async () => {
    await save();
    h.config.gitAuthor = null;
    const result = await commit();
    expect(result.status).toBe(409);
    expect(result.json.status).toBe('git_identity_missing');
    expect(await drafts()).toHaveLength(1);
  });

  it('blocks remote changes before commit with useful Git context', async () => {
    await save();
    const remote = server.commit(REPO, 'main', 'README.md', '# Remote\n');
    const result = await commit();
    expect(result.status).toBe(409);
    expect(result.json).toMatchObject({
      status: 'remote_changed',
      commitSha: null,
      state: { localHeadSha: headSha, remoteHeadSha: remote, behind: 1 },
    });
    expect(await drafts()).toHaveLength(1);
  });

  it('blocks remote changes between commit and push and retains the successful commit', async () => {
    await save();
    const original = provider().commit.bind(provider());
    let remote = '';
    vi.spyOn(provider(), 'commit').mockImplementationOnce(async (input) => {
      const result = await original(input);
      remote = server.commit(REPO, 'main', 'README.md', '# Remote\n');
      return result;
    });
    const before = await drafts();
    const result = await commit({ paths: ['compose.yaml'], message: 'Update', push: true });
    expect(result.status).toBe(409);
    expect(result.json).toMatchObject({
      status: 'remote_changed',
      operation: 'push',
      state: { remoteHeadSha: remote, behind: 1 },
    });
    expect(result.json.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(await git(['rev-parse', 'refs/stack-manager/heads/main'])).toBe(result.json.commitSha + '\n');
    expect(await drafts()).toEqual(before);
    expect(
      (await h.container.audit.list({ workspaceId })).find((a) => a.action === 'git.push_rejected'),
    ).toMatchObject({ outcome: 'failure', meta: { reason: 'remote_changed' } });
  });

  it('preserves drafts and the commit after a real push rejection and permits retry', async () => {
    await save();
    const hook = path.join(server.root, REPO, 'hooks/pre-receive');
    await fs.writeFile(hook, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
    const before = await drafts();
    const result = await commit({ paths: ['compose.yaml'], message: 'Update', push: true });
    expect(result.status).toBe(409);
    expect(result.json.status).toBe('push_rejected');
    expect(await drafts()).toEqual(before);
    expect(await git(['rev-parse', 'refs/stack-manager/heads/main'])).toBe(result.json.commitSha + '\n');
    await fs.rm(hook);
    expect((await push(result.json.commitSha)).json.status).toBe('push_succeeded');
  });

  it.each(['commit', 'push'] as const)(
    'preserves work and hides secrets after %s infrastructure failure',
    async (operation) => {
      await save();
      const before = await drafts();
      const original = GitCli.prototype.run;
      vi.spyOn(GitCli.prototype, 'run').mockImplementation(async function (this: GitCli, args, options) {
        if (args.includes(operation))
          throw new GitOperationError(
            'unknown',
            `${TOKEN} https://bot:${TOKEN}@git.test/ Authorization: sensitive-draft-value`,
          );
        return original.call(this, args, options);
      });
      const result = await commit({ paths: ['compose.yaml'], message: 'Update', push: operation === 'push' });
      expect(result.status).toBe(502);
      expect(result.json).toMatchObject({ status: 'git_operation_failed', operation });
      expect(await drafts()).toEqual(before);
      if (operation === 'commit') expect(result.json.commitSha).toBeNull();
      else
        expect(await git(['rev-parse', 'refs/stack-manager/heads/main'])).toBe(result.json.commitSha + '\n');
      const surfaced =
        result.text +
        h.logs.join('\n') +
        JSON.stringify(
          (await h.container.audit.list({ workspaceId })).filter((a) => a.action.startsWith('git.')),
        );
      expect(surfaced).not.toContain(TOKEN);
      expect(surfaced).not.toContain('https://bot:');
      expect(surfaced).not.toContain('sensitive-draft-value');
    },
  );

  it('does not return parser excerpts or source-derived identifiers in validation failures', async () => {
    await save('bad.json', '{"token":"private-parser-value", broken}');
    const result = await commit({ paths: ['bad.json'], message: 'Update' });
    expect(result.json.status).toBe('validation_blocked');
    expect(result.text).not.toContain('private-parser-value');
  });

  it('rejects unauthenticated, cross-origin and cross-workspace access on every workflow route', async () => {
    await save();
    for (const [handler, method, body] of [
      [statusRoute.GET, 'GET', undefined],
      [commitRoute.POST, 'POST', { paths: ['compose.yaml'], message: 'Update' }],
      [pushRoute.POST, 'POST', { commitSha: headSha, expectedRemoteSha: headSha }],
    ] as const) {
      expect((await call(handler, { method, params: params(), body })).status).toBe(401);
      expect(
        (
          await call(handler, {
            method,
            cookie,
            params: { ...params(), workspaceId: 'other-workspace' },
            body,
          })
        ).status,
      ).toBe(404);
      if (method === 'POST')
        expect(
          (await call(handler, { method, cookie, params: params(), body, origin: 'https://evil.test' }))
            .status,
        ).toBe(403);
    }
    await expect(
      h.container.gitWorkflow.commit(
        workspaceId,
        repositoryId,
        { paths: ['compose.yaml'], message: 'Update' },
        'unknown-user',
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(await drafts()).toHaveLength(1);
  });
});
