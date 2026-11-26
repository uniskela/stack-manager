import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as previewRoute from '@/app/api/workspaces/[workspaceId]/image-updates/preview/route';
import * as publishRoute from '@/app/api/workspaces/[workspaceId]/image-updates/publish/route';
import * as stageRoute from '@/app/api/workspaces/[workspaceId]/image-updates/stage/route';
import { createHarness, type TestHarness } from '../support/container';
import type { ContainerOverrides } from '@/server/container';
import type {
  GiteaCreateImageUpdatePullInput,
  GiteaImageUpdatePull,
} from '@/server/providers/git/gitea-image-update-pulls';
import { GitCli } from '@/server/providers/git/git-cli';
import type { ImageUpdatePreview } from '@/shared/image-update-planning';
import { gitServerOverrides, startGitServer, type GitServer } from '../support/git-server';
import { call } from '../support/http';
import { sessionCookieName } from '@/server/http/cookies';
import * as repositoriesRoute from '@/app/api/workspaces/[workspaceId]/repositories/route';

const repoName = 'acme/image-updates.git';
const remoteUrl = 'https://git.test/' + repoName;
let h: TestHarness | undefined;
let git: GitServer | undefined;
afterEach(async () => {
  const results = await Promise.allSettled([h?.cleanup(), git?.close()]);
  h = undefined;
  git = undefined;
  const failure = results.find((result) => result.status === 'rejected');
  if (failure) throw failure.reason;
});

async function arrange(
  extraFiles: Record<string, string> = {},
  overrides: ContainerOverrides = {},
  authToken?: string,
) {
  git = await startGitServer({ token: authToken });
  git.createRepo(repoName);
  const baseSha = git.commitFiles(repoName, 'main', {
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
    body: {
      gitProviderType: 'gitea',
      remoteUrl,
      auth: authToken ? { type: 'token', token: authToken } : { type: 'none' },
    },
  });
  expect(connection.status).toBe(201);
  await container.worker.runOnce();
  const stacks = await container.stacks.list(workspace.id);
  const main = stacks.find((stack) => stack.composePath === 'compose.yaml')!;
  const second = stacks.find((stack) => stack.composePath === 'second/compose.yaml')!;
  return {
    container,
    workspace,
    user,
    main,
    second,
    cookie,
    stacks,
    baseSha,
    server: git,
    dataDir: h.dataDir,
  };
}

describe('image update draft staging', () => {
  it('keeps valid edits and approvals when other entries in the batch cannot be used', async () => {
    const { workspace, main, second, cookie } = await arrange();
    const request = { method: 'POST', cookie, params: { workspaceId: workspace.id } };
    const preview = await call(previewRoute.POST, {
      ...request,
      body: {
        candidates: [
          { stackId: main.id, service: 'app', source: 'manual', targetTag: '1.28' },
          { stackId: main.id, service: 'missing', source: 'manual', targetTag: '7 # invalid' },
          { stackId: second.id, service: 'cache', source: 'manual', targetTag: '7.4' },
        ],
      },
    });
    expect(preview.status).toBe(200);
    expect(preview.json.files[0].changes.map((row: { status: string }) => row.status)).toEqual([
      'review',
      'blocked',
    ]);

    const stage = await call(stageRoute.POST, {
      ...request,
      body: {
        files: [
          { token: preview.json.files[0].token + 'a', acknowledgeReview: true },
          { token: preview.json.files[1].token, acknowledgeReview: true },
        ],
      },
    });
    expect(stage.status).toBe(200);
    expect(stage.json).toMatchObject({
      rejectedPreviews: 1,
      files: [{ stackId: second.id, status: 'staged' }],
    });
  });

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

  it.each(['anonymous', 'credentialed'])(
    'keeps preview-only and legacy changelog links when TechStack is missing (%s)',
    async (access) => {
      const url = 'https://releases.example.org/nginx/1.28';
      const check = vi
        .fn()
        .mockResolvedValue({ status: 'incomplete', url, signals: [], detail: 'Missing release range.' });
      const { container, workspace, user, main } = await arrange(
        {
          'docs/wud-update-groups.json': JSON.stringify({ groups: [] }),
          '.opencode/skills/portainer-wud-updates/SKILL.md': '# Repository WUD guide\n',
          'docs/container-changelogs.json': JSON.stringify({
            sources: { nginx: { displayUrl: 'https://releases.example.org/nginx/{target_tag}' } },
          }),
        },
        { changelog: { check } },
        access === 'credentialed' ? 'fixture-write-token' : undefined,
      );
      await expect(container.imageUpdateStaging.usesRepositoryWorkflow(workspace.id, main.id)).resolves.toBe(
        true,
      );
      await expect(
        container.imageUpdateStaging.repositoryWorkflowGuide(workspace.id, main.id),
      ).resolves.toEqual({
        policyPath: 'docs/wud-update-groups.json',
        skillPath: '.opencode/skills/portainer-wud-updates/SKILL.md',
        native: false,
      });
      const { files } = await container.imageUpdateStaging.preview(workspace.id, user.id, [
        { stackId: main.id, service: 'app', source: 'manual', targetTag: '1.28' },
      ]);
      expect(check).toHaveBeenCalledWith(url, '1.27', '1.28');
      expect(files[0]).toMatchObject({
        status: 'blocked',
        repositoryWorkflow: true,
        token: null,
        changes: [{ changelogUrl: url, status: 'review' }],
      });
    },
  );

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
    expect(files[0]?.changes[0]?.notes).toContain(
      'WUD supplied this tag without saying when it checked the registry.',
    );
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

const beszelPath = 'flowvps/beszel/docker-compose.yml';
const inventoryPath = 'docs/TechStack.json';
const markdownPath = 'docs/TechStack.md';
const beszelFiles = {
  [beszelPath]: 'services:\n  beszel:\n    image: docker.io/henrygd/beszel:0.21.0 # current pin\n',
  [inventoryPath]:
    '{"stacks":[{"stack":"flowvps","services":[{"name":"beszel","image":"henrygd/beszel:0.21.0"}]}]}\n',
  [markdownPath]:
    'Portainer Stacks (from repo)\nflowvps (previously oracle-vps)\n- beszel: henrygd/beszel:0.21.0\n',
};

async function arrangeNativePublication({
  markdown = beszelFiles[markdownPath],
  checked = false,
  extraFiles = {},
} = {}) {
  const pullUrl = 'https://git.test/acme/image-updates/pulls/12';
  const openPulls: GiteaImageUpdatePull[] = [];
  const close = vi.fn(async ({ number }: { number: number }) => {
    const index = openPulls.findIndex((pull) => pull.number === number);
    if (index >= 0) openPulls.splice(index, 1);
  });
  const create = vi.fn(async ({ head, base, title }: GiteaCreateImageUpdatePullInput) => {
    const headSha = (await remoteGit('rev-parse', 'refs/heads/' + head)).trimEnd();
    const pull = { title, head, base, headSha, sameRepository: true, number: 12, url: pullUrl };
    openPulls.push(pull);
    return pull;
  });
  const changelogUrl = 'https://releases.example.org/beszel/0.21.2';
  const check = vi.fn().mockResolvedValue({
    status: checked ? 'checked' : 'incomplete',
    url: changelogUrl,
    signals: [],
    detail: checked ? '' : 'Missing release range.',
  });
  const read = vi.fn().mockResolvedValue([
    {
      watcher: 'local',
      project: 'beszel',
      service: 'beszel',
      repository: 'index.docker.io/henrygd/beszel',
      installedTag: '0.21.0',
      installedDigest: null,
      checkedAt: checked ? new Date().toISOString() : null,
      available: true,
      failed: false,
      candidateTag: '0.21.2',
      digestOnly: false,
    },
  ]);
  const { container, workspace, user, stacks, cookie, baseSha, server, dataDir } = await arrange(
    {
      ...beszelFiles,
      [markdownPath]: markdown,
      ...extraFiles,
      'docs/wud-update-groups.json': '{"version":1,"groups":[]}\n',
      'docs/container-changelogs.json': JSON.stringify({
        sources: { 'henrygd/beszel': { displayUrl: 'https://releases.example.org/beszel/{target_tag}' } },
      }),
    },
    {
      imageUpdatePulls: {
        list: async () => [...openPulls],
        create,
        get: async ({ number }) => openPulls.find((pull) => pull.number === number) ?? null,
        close,
      },
      changelog: { check },
      wudClient: { read },
    },
    'publication-test-token',
  );
  const cli = new GitCli({ homeDir: path.join(dataDir, 'git-home') });
  async function remoteGit(...args: string[]) {
    return (await cli.run(args, { cwd: path.join(server.root, repoName) })).stdout;
  }

  const stack = stacks.find(({ composePath }) => composePath === beszelPath)!;
  await container.auth.updateGitIdentity(user.id, {
    name: 'Stack Operator',
    email: 'operator@example.invalid',
  });
  await container.imageUpdates.configure(
    workspace.id,
    { baseUrl: 'https://wud.example.org', token: 'fake-read-token', expectedRevision: null },
    user.id,
  );
  await container.imageUpdates.setBinding(
    workspace.id,
    stack.id,
    { watcher: 'local', project: 'beszel' },
    user.id,
  );
  const request = { method: 'POST', cookie, params: { workspaceId: workspace.id } };
  const response = await call(previewRoute.POST, {
    ...request,
    body: { candidates: [{ stackId: stack.id, service: 'beszel', source: 'wud', targetTag: '0.21.2' }] },
  });
  expect(response.status).toBe(200);
  const preview = (response.json as ImageUpdatePreview).files[0]!;
  expect(preview).toMatchObject({ status: 'review', token: expect.any(String) });
  const token = preview.token!;
  const publish = (acknowledgeReview = true) =>
    call(publishRoute.POST, { ...request, body: { token, acknowledgeReview } });

  return {
    container,
    stack,
    stacks,
    request,
    preview,
    token,
    publish,
    baseSha,
    remoteGit,
    openPulls,
    server,
    create,
    close,
    changelogUrl,
    check,
    pullUrl,
  };
}

describe('native Gitea image update publication', () => {
  it('keeps the repository workflow available if a required document read fails', async () => {
    const { container, workspace, user, stacks } = await arrange(
      { ...beszelFiles, 'docs/wud-update-groups.json': '{"version":1,"groups":[]}\n' },
      {},
      'fixture-write-token',
    );
    const stack = stacks.find(({ composePath }) => composePath === beszelPath)!;
    const readFile = container.source.readFile.bind(container.source);
    vi.spyOn(container.source, 'readFile').mockImplementation((...args) => {
      if (args[3] === markdownPath) return Promise.reject(new Error('Git read failed.'));
      return readFile(...args);
    });

    const { files } = await container.imageUpdateStaging.preview(workspace.id, user.id, [
      { stackId: stack.id, service: 'beszel', source: 'manual', targetTag: '0.21.2' },
    ]);
    expect(files[0]).toMatchObject({ repositoryWorkflow: true, status: 'blocked', token: null });
    await expect(container.imageUpdateStaging.usesRepositoryWorkflow(workspace.id, stack.id)).resolves.toBe(
      true,
    );
  });

  it('publishes the reviewed WUD edits once on a proposal branch and leaves main unchanged', async () => {
    const {
      container,
      stack,
      request,
      preview,
      token,
      publish,
      baseSha,
      remoteGit,
      openPulls,
      create,
      changelogUrl,
      check,
      pullUrl,
    } = await arrangeNativePublication();
    expect(check).toHaveBeenCalledWith(changelogUrl, '0.21.0', '0.21.2');
    expect(preview.changes).toMatchObject([
      {
        status: 'review',
        before: 'docker.io/henrygd/beszel:0.21.0',
        after: 'docker.io/henrygd/beszel:0.21.2',
        changelogUrl,
      },
    ]);
    const expectedFiles = Object.fromEntries(
      Object.entries(beszelFiles).map(([file, value]) => [file, value.replace(':0.21.0', ':0.21.2')]),
    );
    expect(preview.proposal).toEqual(
      ([inventoryPath, markdownPath, beszelPath] as const).map((file) => ({
        path: file,
        hunks: [
          expect.objectContaining({
            lines: [
              '-' + beszelFiles[file]!.trimEnd().split('\n').at(-1),
              '+' + expectedFiles[file]!.trimEnd().split('\n').at(-1),
            ],
          }),
        ],
      })),
    );

    const stage = await call(stageRoute.POST, {
      ...request,
      body: { files: [{ token, acknowledgeReview: true }] },
    });
    expect(stage.status).toBe(200);
    expect(stage.json.files[0].status).toBe('failed');
    expect(await container.repos.drafts.find(stack.repository.id, beszelPath)).toBeNull();
    expect((await publish(false)).status).toBe(409);
    expect(await remoteGit('for-each-ref', '--format=%(refname)', 'refs/heads')).toBe('refs/heads/main\n');

    const published = await publish();
    expect(published.status).toBe(200);
    const { head, headSha, title, base } = openPulls[0]!;
    expect(published.json).toEqual({ number: 12, url: pullUrl, repositoryId: stack.repository.id, headSha });
    expect(title).toMatch(/^WIP:/);
    expect(base).toBe('main');
    expect(head).toMatch(/^stack-manager\/image-updates\/[a-f0-9]{32}$/);
    expect(await remoteGit('rev-parse', 'refs/heads/main')).toBe(baseSha + '\n');
    expect(await remoteGit('rev-list', '--parents', '-n', '1', headSha)).toBe(`${headSha} ${baseSha}\n`);
    expect(await remoteGit('diff-tree', '--no-commit-id', '--name-only', '-r', headSha)).toBe(
      [inventoryPath, markdownPath, beszelPath, ''].join('\n'),
    );
    for (const [file, content] of Object.entries(expectedFiles)) {
      expect(await remoteGit('show', `${headSha}:${file}`)).toBe(content);
    }

    const replay = await publish();
    expect(replay.status).toBe(200);
    expect(replay.json).toEqual(published.json);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('publishes selected stacks together and updates their shared documents in one commit', async () => {
    const { stacks, stack, request, remoteGit, create } = await arrangeNativePublication({
      extraFiles: {
        [inventoryPath]:
          '{"stacks":[{"stack":"flowvps","services":[{"name":"beszel","image":"henrygd/beszel:0.21.0"}]},{"stack":"second","services":[{"name":"cache","image":"redis:7.2"}]}]}',
        [markdownPath]: beszelFiles[markdownPath] + '\nsecond\n- cache: redis:7.2\n',
      },
    });
    const second = stacks.find((item) => item.composePath === 'second/compose.yaml')!;
    const preview = await call(previewRoute.POST, {
      ...request,
      body: {
        candidates: [
          { stackId: stack.id, service: 'beszel', source: 'wud', targetTag: '0.21.2' },
          { stackId: second.id, service: 'cache', source: 'manual', targetTag: '7.4' },
        ],
      },
    });
    expect(preview.json.files).toHaveLength(1);
    const [file] = preview.json.files;
    expect(file.proposal).toHaveLength(4);
    const published = await call(publishRoute.POST, {
      ...request,
      body: { token: file.token, acknowledgeReview: true },
    });
    expect(published.status).toBe(200);
    expect(create).toHaveBeenCalledOnce();
    for (const path of [markdownPath, inventoryPath]) {
      const contents = await remoteGit('show', published.json.headSha + ':' + path);
      expect(contents).toContain('henrygd/beszel:0.21.2');
      expect(contents).toContain('redis:7.4');
    }
  });

  it('offers Compose-only stacks a grouped PR while retaining the draft workflow', async () => {
    const { workspace, main, second, cookie } = await arrange({}, {}, 'fixture-write-token');
    const request = { method: 'POST', cookie, params: { workspaceId: workspace.id } };
    const candidates = [
      { stackId: main.id, service: 'app', source: 'manual', targetTag: '1.28' },
      { stackId: second.id, service: 'cache', source: 'manual', targetTag: '7.4' },
    ];
    const drafts = await call(previewRoute.POST, { ...request, body: { candidates } });
    expect(drafts.json.files).toHaveLength(2);
    expect(drafts.json.files[0].composePullAvailable).toBe(true);
    const grouped = await call(previewRoute.POST, { ...request, body: { candidates, preferPull: true } });
    expect(grouped.json.files).toHaveLength(1);
    expect(grouped.json.files[0].proposal.map((item: { path: string }) => item.path)).toEqual([
      'compose.yaml',
      'second/compose.yaml',
    ]);
  });

  it('closes only the confirmed predecessor after the replacement exists and safely replays', async () => {
    const { publish, openPulls, request, token, baseSha, create, close } = await arrangeNativePublication();
    const previous = {
      number: 2,
      url: 'https://git.test/acme/image-updates/pulls/2',
      head: 'chore/wud-updates-old',
      sameRepository: true,
      title: 'Old proposal',
      base: 'main',
      headSha: baseSha,
    };
    openPulls.push(previous);
    const blocked = await publish();
    expect(blocked.json.error.fields.number).toBe('2');
    const replace = (headSha: string) =>
      call(publishRoute.POST, {
        ...request,
        body: { token, acknowledgeReview: true, supersede: { number: 2, headSha } },
      });
    expect((await replace('f'.repeat(40))).status).toBe(409);
    create.mockRejectedValueOnce(new Error('forge unavailable'));
    expect((await replace(baseSha)).status).toBeGreaterThanOrEqual(400);
    expect(openPulls).toEqual([previous]);
    close.mockRejectedValueOnce(new Error('Gitea unavailable'));
    expect((await replace(baseSha)).status).toBe(409);
    expect(openPulls.map((pull) => pull.number)).toEqual([2, 12]);
    expect((await publish()).json.error.fields.number).toBe('2');
    expect((await replace(baseSha)).status).toBe(200);
    expect(openPulls.map((pull) => pull.number)).toEqual([12]);
    expect((await replace(baseSha)).status).toBe(200);
  });

  it('publishes a reviewable update when the Markdown version is free text', async () => {
    const markdown = beszelFiles[markdownPath].replace('henrygd/beszel:0.21.0', 'see dashboard for version');
    const { preview, publish, create, remoteGit, openPulls } = await arrangeNativePublication({
      markdown,
      checked: true,
    });
    expect(preview.changes[0]?.status).toBe('ready');
    expect(preview.reason).toContain('Check the beszel entry in docs/TechStack.md');
    expect(preview.proposal?.map(({ path }) => path)).toEqual([inventoryPath, beszelPath]);
    expect((await publish(false)).status).toBe(409);
    expect((await publish()).status).toBe(200);
    expect(create.mock.calls[0]?.[0].body).toContain(preview.reason);
    expect(await remoteGit('show', openPulls[0]!.headSha + ':' + markdownPath)).toBe(markdown);
  });

  it.each(['moved main', 'an open legacy update pull request'])(
    'retains the remote refs when publishing is blocked by %s',
    async (conflict) => {
      const { publish, baseSha, remoteGit, openPulls, server, create } = await arrangeNativePublication();
      const headSha =
        conflict === 'moved main'
          ? server.commit(repoName, 'main', 'README.md', '# Another change\n')
          : baseSha;
      if (conflict === 'an open legacy update pull request') {
        openPulls.push({
          number: 3,
          url: 'https://git.test/acme/image-updates/pulls/3',
          base: 'main',
          head: 'auto-portainer-wud-updates-2026-11-26',
          headSha,
          title: 'chore: update images',
          sameRepository: true,
        });
      }
      const outcome = await publish();
      expect(outcome.status).toBe(409);
      expect(create).not.toHaveBeenCalled();
      expect(await remoteGit('for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads')).toBe(
        headSha + ' refs/heads/main\n',
      );
    },
  );
});
