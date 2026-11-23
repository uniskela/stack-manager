import { afterEach, describe, expect, it, vi } from 'vitest';
import * as previewRoute from '@/app/api/workspaces/[workspaceId]/image-updates/preview/route';
import * as stageRoute from '@/app/api/workspaces/[workspaceId]/image-updates/stage/route';
import { createHarness, type TestHarness } from '../support/container';
import type { ContainerOverrides } from '@/server/container';
import { gitServerOverrides, startGitServer, type GitServer } from '../support/git-server';
import { call } from '../support/http';
import { sessionCookieName } from '@/server/http/cookies';
import * as repositoriesRoute from '@/app/api/workspaces/[workspaceId]/repositories/route';

const repoName = 'image-updates.git';
let h: TestHarness | undefined;
let git: GitServer | undefined;
afterEach(async () => {
  await h?.cleanup();
  await git?.close();
});

async function arrange(extraFiles: Record<string, string> = {}, overrides: ContainerOverrides = {}) {
  git = await startGitServer();
  git.createRepo(repoName);
  git.commitFiles(repoName, 'main', {
    'second/compose.yaml':
      'services:\n  cache:\n    image: redis:7.2\n    env_file: /run/infisical/cache.env\n',
    ...extraFiles,
  });
  h = await createHarness({ overrides: { ...gitServerOverrides(git), ...overrides } });
  const { container } = h;
  const { user, token } = await container.auth.setupAdmin(
    { username: 'admin', password: 'a random test password' },
    { ip: null, userAgent: null },
  );
  const workspace = await container.workspaces.create({ name: 'Test workspace' }, user.id);
  const cookie = sessionCookieName(h.config) + '=' + token;
  const connection = await call(repositoriesRoute.POST, {
    method: 'POST',
    params: { workspaceId: workspace.id },
    cookie,
    body: { gitProviderType: 'gitea', remoteUrl: 'https://git.test/' + repoName, auth: { type: 'none' } },
  });
  expect(connection.status).toBe(201);
  await container.worker.runOnce();
  const stacks = await container.stacks.list(workspace.id);
  const main = stacks.find((stack) => stack.composePath === 'compose.yaml')!;
  const second = stacks.find((stack) => stack.composePath === 'second/compose.yaml')!;
  return { container, workspace, user, main, second, cookie };
}

describe('image update draft staging', () => {
  it('holds a file if its stack was deleted just before the draft transaction', async () => {
    const { container, workspace, user, main } = await arrange();
    const { imageUpdateStaging, repos } = container;
    const { files } = await imageUpdateStaging.preview(workspace.id, user.id, [
      { stackId: main.id, service: 'app', source: 'manual', targetTag: '1.28' },
    ]);
    const insert = repos.drafts.insertAtHead.bind(repos.drafts);
    vi.spyOn(repos.drafts, 'insertAtHead').mockImplementationOnce(async (...args) => {
      await repos.stacks.delete(main.id);
      return insert(...args);
    });
    const staged = await imageUpdateStaging.stage(workspace.id, user.id, [
      { token: files[0]!.token!, acknowledgeReview: true },
    ]);
    expect(staged.files[0]?.status).toBe('source_changed');
    expect(await repos.drafts.find(main.repository.id, main.composePath)).toBeNull();
  });
  it('previews and stages manual updates without WUD, preserving an unrelated existing draft', async () => {
    const { container, workspace, user, main, second } = await arrange();
    const { imageUpdateStaging, source } = container;
    const preview = await imageUpdateStaging.preview(workspace.id, user.id, [
      { stackId: main.id, service: 'app', source: 'manual', targetTag: '1.28' },
      { stackId: second.id, service: 'cache', source: 'manual', targetTag: '7.4' },
    ]);
    expect(preview.files.map((file) => file.status)).toEqual(['review', 'review']);
    const file = await source.readFile(workspace.id, main.repository.id, '', main.composePath);
    await source.saveDraft(
      workspace.id,
      main.repository.id,
      '',
      {
        path: main.composePath,
        baseBlobSha: file.blobSha,
        content: file.content + '# My draft\n',
      },
      user.id,
    );
    const stage = await imageUpdateStaging.stage(
      workspace.id,
      user.id,
      preview.files.map((file) => ({
        token: file.token!,
        acknowledgeReview: true,
      })),
    );
    expect(stage.files.map((row) => row.status)).toEqual(['draft_exists', 'staged']);
    expect(
      (await source.readFile(workspace.id, main.repository.id, '', main.composePath)).draft?.content,
    ).toContain('# My draft');
    expect(
      (await source.readFile(workspace.id, second.repository.id, second.rootPath, second.composePath)).draft
        ?.content,
    ).toContain('image: redis:7.4\n    env_file: /run/infisical/cache.env\n');
  });

  it('applies the committed repository policy and stages only acknowledged eligible files over HTTP', async () => {
    const { workspace, main, second, cookie } = await arrange({
      '.stack-manager/image-updates.json': JSON.stringify({
        version: 1,
        exclude: [{ path: 'compose.yaml', service: 'app' }],
      }),
    });
    const request = { method: 'POST', cookie, params: { workspaceId: workspace.id } };
    const preview = await call(previewRoute.POST, {
      ...request,
      body: {
        candidates: [
          { stackId: main.id, service: 'app', source: 'manual', targetTag: '1.28' },
          { stackId: second.id, service: 'cache', source: 'manual', targetTag: '7.4' },
        ],
      },
    });
    expect(preview.status).toBe(200);
    expect(preview.json.files.map((file: { status: string }) => file.status)).toEqual(['blocked', 'review']);
    expect(preview.json.files[0].token).toBeNull();
    const token = preview.json.files[1].token as string;
    const attempt = (value: string, acknowledgeReview: boolean) =>
      call(stageRoute.POST, {
        ...request,
        body: { files: [{ token: value, acknowledgeReview }] },
      });
    expect((await attempt(token + 'a', true)).status).toBe(409);
    expect((await attempt(token, false)).json.files[0].status).toBe('review_required');
    expect((await attempt(token, true)).json.files[0].status).toBe('staged');
    expect((await attempt(token, true)).json.files[0].status).toBe('draft_exists');
  });

  it('uses the published legacy changelog links without staging around linked-file policies', async () => {
    const url = 'https://releases.example.org/nginx/1.28';
    const check = vi
      .fn()
      .mockResolvedValue({ status: 'incomplete', url, signals: [], detail: 'Missing release range.' });
    const { container, workspace, user, main } = await arrange(
      {
        'docs/wud-update-groups.json': JSON.stringify({ groups: [] }),
        'docs/container-changelogs.json': JSON.stringify({
          sources: { nginx: { displayUrl: 'https://releases.example.org/nginx/{target_tag}' } },
        }),
      },
      { changelog: { check } },
    );
    const { files } = await container.imageUpdateStaging.preview(workspace.id, user.id, [
      { stackId: main.id, service: 'app', source: 'manual', targetTag: '1.28' },
    ]);
    expect(check).toHaveBeenCalledWith(url, '1.27', '1.28');
    expect(files[0]).toMatchObject({
      status: 'blocked',
      token: null,
      changes: [{ changelogUrl: url, status: 'review' }],
    });
  });

  it('rechecks a WUD candidate before staging its preview', async () => {
    const read = vi.fn();
    const observation = {
      watcher: 'local',
      project: 'compose',
      service: 'app',
      repository: 'index.docker.io/library/nginx',
      installedTag: '1.27',
      installedDigest: null,
      checkedAt: null,
      available: true,
      failed: false,
      candidateTag: '1.28',
      digestOnly: false,
    };
    read.mockResolvedValue([observation]);
    const changelogUrl = 'https://releases.example.org/nginx';
    const check = vi.fn().mockResolvedValue({
      status: 'checked',
      url: changelogUrl,
      signals: [],
      detail: 'Release range found.',
    });
    const { container, workspace, user, main } = await arrange(
      {},
      { wudClient: { read }, changelog: { check } },
    );
    const { imageUpdates, imageUpdateStaging } = container;
    const connection = { baseUrl: 'https://wud.example.org', token: 'read-token' };
    const configured = await imageUpdates.configure(
      workspace.id,
      { ...connection, expectedRevision: null },
      user.id,
    );
    await imageUpdates.setBinding(workspace.id, main.id, { watcher: 'local', project: 'compose' }, user.id);
    const { files } = await imageUpdateStaging.preview(workspace.id, user.id, [
      { stackId: main.id, service: 'app', source: 'wud', targetTag: '1.28', changelogUrl },
    ]);
    expect(files[0]?.status).toBe('review');
    expect(files[0]?.changes[0]?.notes).toContain('WUD reports this candidate without its last scan time.');
    read.mockResolvedValue([{ ...observation, candidateTag: '1.29' }]);
    await imageUpdates.configure(
      workspace.id,
      { ...connection, expectedRevision: configured.revision },
      user.id,
    );
    const staged = await imageUpdateStaging.stage(workspace.id, user.id, [
      { token: files[0]!.token!, acknowledgeReview: true },
    ]);
    expect(staged.files[0]?.status).toBe('candidate_changed');
  });
});
