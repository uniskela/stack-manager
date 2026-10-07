import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as commitRoute from '@/app/api/workspaces/[workspaceId]/repositories/[repositoryId]/git/commit/route';
import * as pushRoute from '@/app/api/workspaces/[workspaceId]/repositories/[repositoryId]/git/push/route';
import * as stackHistory from '@/app/api/workspaces/[workspaceId]/stacks/[stackId]/history/route';
import * as stackDetail from '@/app/api/workspaces/[workspaceId]/stacks/[stackId]/history/[sha]/route';
import * as setup from '@/app/api/setup/route';
import { GitCli } from '@/server/providers/git/git-cli';
import type { HistoryDetail, HistoryPage } from '@/shared/git-history';
import { createHarness, type TestHarness } from '../support/container';
import { gitServerOverrides, startGitServer, type GitServer } from '../support/git-server';
import { call, cookieFrom } from '../support/http';

/**
 * End-to-end journeys across the v0.5.0 boundaries (drafts → workflow → Git → fetch → history → audit).
 * Per-outcome workflow cases live in git-workflow.test.ts; this file only covers what crosses services.
 */
const REPO = 'acme/journey.git';
const REMOTE = `https://git.test/${REPO}`;
const TOKEN = 'journey-test-' + '0123456789abcdef';
const WRONG_TOKEN = 'journey-wrong-' + '0123456789abcdef';
const AUTHOR = { name: 'Stack Operator', email: 'operator@example.invalid' };
const COMPOSE = 'services:\n  app:\n    image: nginx:1.27\n';
let server: GitServer;
let h: TestHarness;
let cookie: string;
let workspaceId: string;
let repositoryId: string;
let actorUserId: string;
let wikiId: string;
let notesId: string;

beforeEach(async () => {
  server = await startGitServer({ token: TOKEN });
  server.createRepo(REPO);
  server.commitFiles(REPO, 'main', {
    'apps/wiki/compose.yaml': COMPOSE,
    'apps/notes/compose.yaml': COMPOSE,
  });
  h = await createHarness({ overrides: gitServerOverrides(server) });
  const admin = await call(setup.POST, {
    method: 'POST',
    body: { username: 'admin', password: 'correct horse battery staple' },
  });
  cookie = cookieFrom(admin);
  actorUserId = admin.json.user.id;
  await h.container.auth.updateGitIdentity(actorUserId, AUTHOR);
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
  const stack = (rootPath: string) =>
    h.container.stacks.create(
      workspaceId,
      repositoryId,
      { rootPath, composePath: `${rootPath}/compose.yaml` },
      actorUserId,
    );
  wikiId = (await stack('apps/wiki')).id;
  notesId = (await stack('apps/notes')).id;
});

afterEach(async () => {
  await h.cleanup();
  await server.close();
});

const params = () => ({ workspaceId, repositoryId });
const commit = (body: Record<string, unknown>) =>
  call(commitRoute.POST, { method: 'POST', cookie, params: params(), body });
const push = (commitSha: string, expectedRemoteSha: string) =>
  call(pushRoute.POST, { method: 'POST', cookie, params: params(), body: { commitSha, expectedRemoteSha } });
const history = async (stackId: string) =>
  (await call(stackHistory.GET, { cookie, params: { workspaceId, stackId }, path: '/history' }))
    .json as HistoryPage;
const drafts = () => h.container.repos.drafts.list(repositoryId);
async function save(file: string, content: string) {
  const view = await h.container.source.readFile(workspaceId, repositoryId, '', file);
  return h.container.source.saveDraft(
    workspaceId,
    repositoryId,
    '',
    { path: file, content, baseBlobSha: view.blobSha },
    actorUserId,
  );
}
async function git(args: string[]) {
  const overrides = gitServerOverrides(server);
  const cli = new GitCli({
    homeDir: path.join(h.dataDir, 'git-home'),
    allowedProtocols: overrides.gitAllowedProtocols,
    extraConfig: overrides.gitExtraConfig,
  });
  const source = (await h.container.repositories.localSource(workspaceId, repositoryId))!;
  return (await cli.run(args, { cwd: source.cloneDir })).stdout;
}

describe('Git workflow journeys', () => {
  it('draft → commit → push → fetch shows the commit in the stack history it touched, and only there', async () => {
    const edited = COMPOSE.replace('nginx:1.27', 'nginx:1.28');
    await save('apps/wiki/compose.yaml', edited);
    const committed = await commit({ paths: ['apps/wiki/compose.yaml'], message: 'Bump wiki\n\nWhy: patch' });
    expect(committed.json.status).toBe('commit_succeeded');
    const sha: string = committed.json.commitSha;

    // An unpushed commit is not history yet: history reads the last fetched snapshot only.
    expect((await history(wikiId)).commits.map((c) => c.sha)).not.toContain(sha);

    expect((await push(sha, committed.json.expectedRemoteSha)).json.status).toBe('push_succeeded');
    expect((await history(wikiId)).commits.map((c) => c.sha)).not.toContain(sha);
    await h.container.repositories.sync(repositoryId);

    const wiki = await history(wikiId);
    expect(wiki.headSha).toBe(sha);
    expect(wiki.commits[0]).toMatchObject({
      sha,
      subject: 'Bump wiki',
      author: AUTHOR,
      files: [{ path: 'apps/wiki/compose.yaml', status: 'modified' }],
    });
    expect((await history(notesId)).commits.map((c) => c.sha)).not.toContain(sha);

    const detail = (await call(stackDetail.GET, { cookie, params: { workspaceId, stackId: wikiId, sha } }))
      .json as HistoryDetail;
    expect(detail.commit.files[0]!.hunks![0]!.lines).toEqual(
      expect.arrayContaining(['-    image: nginx:1.27', '+    image: nginx:1.28']),
    );

    // Audit links the commit to the registered stack it touched, without contents or the message.
    const audit = (await h.container.audit.list({ workspaceId })).filter((a) => a.action.startsWith('git.'));
    expect(audit.find((a) => a.action === 'git.commit')).toMatchObject({
      outcome: 'success',
      meta: { commitSha: sha, branch: 'main', changedFileCount: 1, stackIds: [wikiId] },
    });
    expect(audit.find((a) => a.action === 'git.push')).toMatchObject({ outcome: 'success' });
    expect(JSON.stringify(audit)).not.toContain('nginx:1.28');
    expect(JSON.stringify(audit)).not.toContain('Bump wiki');
    expect(JSON.stringify(audit)).not.toContain(AUTHOR.email);

    // Drafts are kept after a successful push; once fetched, the committed draft can be reviewed/discarded.
    expect((await drafts()).map((d) => d.path)).toEqual(['apps/wiki/compose.yaml']);
  });

  it('a push refused for bad credentials keeps the commit and drafts, leaks no token, and retries', async () => {
    await save('apps/notes/compose.yaml', COMPOSE + '# notes\n');
    const committed = await commit({ paths: ['apps/notes/compose.yaml'], message: 'Notes' });
    const sha: string = committed.json.commitSha;
    const before = await drafts();

    const repo = await h.container.repos.gitRepositories.findById(workspaceId, repositoryId);
    await h.container.credentials.replaceSecret(workspaceId, repo!.credentialId!, WRONG_TOKEN, actorUserId);
    const failed = await push(sha, committed.json.expectedRemoteSha);
    expect(failed.status).toBe(502);
    expect(failed.json).toMatchObject({
      status: 'git_operation_failed',
      operation: 'push',
      reason: 'auth',
      commitSha: sha,
      draftsPreserved: true,
    });
    expect(await drafts()).toEqual(before);
    expect(await git(['rev-parse', 'refs/stack-manager/heads/main'])).toBe(sha + '\n');
    const surfaced =
      failed.text + h.logs.join('\n') + JSON.stringify(await h.container.audit.list({ workspaceId }));
    for (const secret of [TOKEN, WRONG_TOKEN]) expect(surfaced).not.toContain(secret);
    // The Git failure itself carries no remote URL or provider output either.
    const gitAudit = (await h.container.audit.list({ workspaceId })).filter((a) =>
      a.action.startsWith('git.'),
    );
    expect(failed.text + JSON.stringify(gitAudit)).not.toContain('git.test');
    expect(
      (await h.container.audit.list({ workspaceId })).find((a) => a.action === 'git.push_rejected'),
    ).toMatchObject({ outcome: 'failure', meta: { gitReason: 'auth', commitSha: sha } });

    await h.container.credentials.replaceSecret(workspaceId, repo!.credentialId!, TOKEN, actorUserId);
    expect((await push(sha, committed.json.expectedRemoteSha)).json.status).toBe('push_succeeded');
  });

  it('documented recovery: removing a stranded unpushed commit lets drafts be committed on the new remote', async () => {
    await save('apps/wiki/compose.yaml', COMPOSE + '# wiki\n');
    const stranded = await commit({ paths: ['apps/wiki/compose.yaml'], message: 'Wiki' });
    const remote = server.commit(REPO, 'main', 'README.md', '# Changed elsewhere\n');
    const blocked = await push(stranded.json.commitSha, stranded.json.expectedRemoteSha);
    expect(blocked.json).toMatchObject({ status: 'remote_changed', state: { ahead: 1, behind: 1 } });
    await h.container.repositories.sync(repositoryId);
    // Still blocked after a fetch: Stack Manager never merges, rebases or drops the unpushed commit itself.
    await save('apps/notes/compose.yaml', COMPOSE + '# notes\n');
    expect((await commit({ paths: ['apps/notes/compose.yaml'], message: 'Notes' })).json.status).toBe(
      'remote_changed',
    );

    // GIT_WORKFLOW.md: `git update-ref -d refs/stack-manager/heads/<branch>` in the repository's clone.
    // The drafts were kept, so the stranded change can be committed again on top of the new remote.
    await git(['update-ref', '-d', 'refs/stack-manager/heads/main']);
    const next = await commit({
      paths: ['apps/wiki/compose.yaml', 'apps/notes/compose.yaml'],
      message: 'Wiki and notes',
      push: true,
    });
    expect(next.json.status).toBe('push_succeeded');
    expect(await git(['rev-parse', `${next.json.commitSha}^`])).toBe(remote + '\n');
    expect(await drafts()).toHaveLength(2);
  });
});
