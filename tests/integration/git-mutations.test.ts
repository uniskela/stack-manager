import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitCli, type GitRunOptions } from '@/server/providers/git/git-cli';
import { HttpGitProvider } from '@/server/providers/git/http-git-provider';
import { BUILTIN_GIT_PROVIDERS } from '@/server/providers/git/registry';
import { GitOperationError } from '@/server/providers/git/types';
import { gitServerOverrides, startGitServer, type GitServer } from '../support/git-server';

const REPO = 'acme/mutations.git';
const REMOTE = `https://git.test/${REPO}`;
const TOKEN = 'mutation-test-' + '0123456789abcdef';
const AUTH = { username: 'deploy-bot', token: TOKEN };
const AUTHOR = { name: 'Stack Operator', email: 'operator@example.invalid' };
const COMPOSE = 'services:\n  app:\n    image: nginx:1.27\n';

/** Runs real Git; callbacks inject failure or a remote race at a specific operation boundary. */
class ObservedGitCli extends GitCli {
  calls: string[][] = [];
  beforeRun?: (args: readonly string[], options: GitRunOptions) => void | Promise<void>;
  afterRun?: (args: readonly string[], options: GitRunOptions) => void | Promise<void>;

  override async run(args: readonly string[], options: GitRunOptions = {}) {
    this.calls.push([...args]);
    await this.beforeRun?.(args, options);
    const result = await super.run(args, options);
    await this.afterRun?.(args, options);
    return result;
  }
}

let server: GitServer;
let dataDir: string;
let reposDir: string;
let cloneDir: string;
let git: ObservedGitCli;
let provider: HttpGitProvider;
let headSha: string;
let composeBlobSha: string;

beforeEach(async () => {
  server = await startGitServer(AUTH);
  server.createRepo(REPO);
  server.commitFiles(REPO, 'main', {
    'README.md': '# Stacks\n',
    'config/app.json': '{"debug":false}\n',
    'link-out': { symlink: '../../outside' },
  });
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stack-manager-mutations-'));
  reposDir = path.join(dataDir, 'repos');
  cloneDir = path.join(reposDir, 'repo');
  const overrides = gitServerOverrides(server);
  git = new ObservedGitCli({
    homeDir: path.join(dataDir, 'git-home'),
    allowedProtocols: overrides.gitAllowedProtocols,
    extraConfig: overrides.gitExtraConfig,
  });
  provider = new HttpGitProvider(BUILTIN_GIT_PROVIDERS[0]!, git, 'x-access-token', reposDir);
  const synced = await provider.syncClone({
    remoteUrl: REMOTE,
    branch: 'main',
    targetDir: cloneDir,
    auth: AUTH,
  });
  headSha = synced.headSha;
  composeBlobSha = (await git.run(['rev-parse', `${headSha}:compose.yaml`], { cwd: cloneDir })).stdout.trim();
});

afterEach(async () => {
  await server.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

const connection = () => ({ cloneDir, branch: 'main', remoteUrl: REMOTE, auth: AUTH });
const draft = () => ({ path: 'compose.yaml', content: COMPOSE + '# draft\n', baseBlobSha: composeBlobSha });
const commitInput = () => ({
  ...connection(),
  expectedHeadSha: headSha,
  changes: [draft()],
  message: 'Update stack\n\nSelected database draft.',
  author: AUTHOR,
});
const pushInput = (commitSha: string) => ({ ...connection(), commitSha, expectedRemoteSha: headSha });

async function changedPaths(sha: string) {
  const { stdout } = await git.run(['diff-tree', '--no-commit-id', '--name-only', '-r', sha], {
    cwd: cloneDir,
  });
  return stdout.trim().split('\n').filter(Boolean).sort();
}

async function assertCleanedUp() {
  expect((await fs.readdir(reposDir)).filter((name) => name.startsWith('.mutation-'))).toEqual([]);
  const { stdout } = await git.run(['worktree', 'list', '--porcelain'], { cwd: cloneDir });
  expect(stdout.split('\n').filter((line) => line.startsWith('worktree '))).toEqual([`worktree ${cloneDir}`]);
}

async function assertCloneUsable() {
  await git.run(['fsck', '--no-dangling'], { cwd: cloneDir });
  expect((await git.run(['rev-parse', 'HEAD'], { cwd: cloneDir })).stdout.trim()).toBe(headSha);
  expect(await fs.readFile(path.join(cloneDir, 'compose.yaml'), 'utf8')).toBe(COMPOSE);
}

describe('isolated Git commits', () => {
  it('returns only commit metadata and refuses Git directory indirection', async () => {
    await expect(provider.getCommit(cloneDir, composeBlobSha)).rejects.toMatchObject({ kind: 'invalid' });
    const metadata = path.join(cloneDir, '.git');
    const moved = path.join(dataDir, 'moved-git');
    await fs.rename(metadata, moved);
    try {
      await fs.symlink(moved, metadata);
      await expect(provider.getCommit(cloneDir, headSha)).rejects.toMatchObject({ kind: 'invalid' });
      await expect(provider.commit(commitInput())).rejects.toMatchObject({ kind: 'invalid' });
    } finally {
      await fs.rm(metadata, { force: true });
      await fs.rename(moved, metadata);
    }
    await assertCloneUsable();
  });

  it('does not overwrite an unexpected retained-ref change during commit creation', async () => {
    git.afterRun = async (args) => {
      if (args.includes('commit')) {
        git.afterRun = undefined;
        await git.run(['update-ref', 'refs/stack-manager/heads/main', headSha], { cwd: cloneDir });
      }
    };
    await expect(provider.commit(commitInput())).rejects.toThrow();
    expect(
      (await git.run(['rev-parse', 'refs/stack-manager/heads/main'], { cwd: cloneDir })).stdout.trim(),
    ).toBe(headSha);
    await assertCleanedUp();
    await assertCloneUsable();
  });

  it('commits one selected draft, preserves caller data and returns real author and commit metadata', async () => {
    const input = commitInput();
    const savedInput = structuredClone(input);
    const committed = await provider.commit(input);
    expect(committed.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(committed.parents).toEqual([headSha]);
    expect(committed.author).toEqual(AUTHOR);
    expect(committed.committer).toEqual(AUTHOR);
    expect(committed.message.trim()).toBe(input.message);
    expect(Number.isNaN(Date.parse(committed.authoredAt))).toBe(false);
    expect(Number.isNaN(Date.parse(committed.committedAt))).toBe(false);
    expect(await provider.getCommit(cloneDir, committed.sha)).toEqual(committed);
    expect(await changedPaths(committed.sha)).toEqual(['compose.yaml']);
    expect((await git.run(['show', `${committed.sha}:compose.yaml`], { cwd: cloneDir })).stdout).toBe(
      draft().content,
    );
    expect(input).toEqual(savedInput);
    await assertCleanedUp();
    await assertCloneUsable();
  });

  it('commits multiple selected files and excludes unrelated staged, modified and untracked clone files', async () => {
    await fs.writeFile(path.join(cloneDir, 'README.md'), '# Unrelated staged content\n');
    await git.run(['add', '--', 'README.md'], { cwd: cloneDir });
    await fs.writeFile(path.join(cloneDir, 'config/app.json'), '{"debug":true}\n');
    await fs.writeFile(path.join(cloneDir, 'untracked.txt'), 'unrelated\n');
    const indexBefore = (await git.run(['diff', '--cached'], { cwd: cloneDir })).stdout;
    const committed = await provider.commit({
      ...commitInput(),
      changes: [draft(), { path: 'docs/runbook.md', content: '# Runbook\n', baseBlobSha: null }],
    });
    expect(await changedPaths(committed.sha)).toEqual(['compose.yaml', 'docs/runbook.md']);
    expect((await git.run(['show', `${committed.sha}:README.md`], { cwd: cloneDir })).stdout).toBe(
      '# Stacks\n',
    );
    expect((await git.run(['show', `${committed.sha}:config/app.json`], { cwd: cloneDir })).stdout).toBe(
      '{"debug":false}\n',
    );
    await expect(git.run(['show', `${committed.sha}:untracked.txt`], { cwd: cloneDir })).rejects.toThrow();
    expect((await git.run(['diff', '--cached'], { cwd: cloneDir })).stdout).toBe(indexBefore);
    expect(await fs.readFile(path.join(cloneDir, 'untracked.txt'), 'utf8')).toBe('unrelated\n');
    await assertCleanedUp();
  });

  it('supports controlled deletions and chains subsequent commits on the retained local head', async () => {
    const readmeBlob = (
      await git.run(['rev-parse', `${headSha}:README.md`], { cwd: cloneDir })
    ).stdout.trim();
    const first = await provider.commit({
      ...commitInput(),
      changes: [{ path: 'README.md', content: null, baseBlobSha: readmeBlob }],
    });
    expect(await changedPaths(first.sha)).toEqual(['README.md']);
    const second = await provider.commit({ ...commitInput(), expectedHeadSha: first.sha });
    expect(second.parents).toEqual([first.sha]);
    expect(await changedPaths(second.sha)).toEqual(['compose.yaml']);
    const branch = await provider.inspectBranch(connection());
    expect(branch).toEqual({
      branch: 'main',
      localHeadSha: second.sha,
      remoteHeadSha: headSha,
      ahead: 2,
      behind: 0,
    });
    await assertCleanedUp();
    await assertCloneUsable();
  });

  it('stages explicitly selected ignored files and treats pathspec-shaped names literally', async () => {
    server.commitFiles(REPO, 'main', { '.gitignore': 'ignored/*\n' });
    headSha = (
      await provider.syncClone({
        remoteUrl: REMOTE,
        branch: 'main',
        targetDir: cloneDir,
        auth: AUTH,
      })
    ).headSha;
    const committed = await provider.commit({
      ...commitInput(),
      changes: [
        { path: 'ignored/[operator].md', content: '# Selected\n', baseBlobSha: null },
        { path: ':(glob)README*', content: 'literal filename\n', baseBlobSha: null },
      ],
    });
    expect(await changedPaths(committed.sha)).toEqual([':(glob)README*', 'ignored/[operator].md']);
    expect((await git.run(['show', `${committed.sha}:README.md`], { cwd: cloneDir })).stdout).toBe(
      '# Stacks\n',
    );
    await assertCleanedUp();
  });

  it('rejects stale expected heads and stale draft blobs without changing the clone', async () => {
    await expect(
      provider.commit({ ...commitInput(), expectedHeadSha: '0'.repeat(40) }),
    ).rejects.toMatchObject({ kind: 'conflict' });
    await expect(
      provider.commit({ ...commitInput(), changes: [{ ...draft(), baseBlobSha: '0'.repeat(40) }] }),
    ).rejects.toMatchObject({ kind: 'conflict' });
    await expect(
      provider.commit({ ...commitInput(), changes: [{ ...draft(), baseBlobSha: null }] }),
    ).rejects.toMatchObject({ kind: 'conflict' });
    await assertCleanedUp();
    await assertCloneUsable();
  });

  it('rejects empty and unchanged selections rather than producing an empty commit', async () => {
    await expect(provider.commit({ ...commitInput(), changes: [] })).rejects.toThrow();
    await expect(
      provider.commit({ ...commitInput(), changes: [{ ...draft(), content: COMPOSE }] }),
    ).rejects.toThrow();
    await assertCleanedUp();
    await assertCloneUsable();
  });

  it('rejects escaping paths, secret files, Git internals, symlink paths and conflicting file paths', async () => {
    for (const file of [
      '../outside.txt',
      '/tmp/outside.txt',
      '.git/config',
      '.env',
      'secrets/password.txt',
      'link-out/file.txt',
      'config/app.json/child.txt',
      'config',
    ]) {
      await expect(
        provider.commit({
          ...commitInput(),
          changes: [{ path: file, content: 'changed\n', baseBlobSha: null }],
        }),
        file,
      ).rejects.toThrow();
    }
    const linkBlob = (await git.run(['rev-parse', `${headSha}:link-out`], { cwd: cloneDir })).stdout.trim();
    await expect(
      provider.commit({
        ...commitInput(),
        changes: [{ path: 'link-out', content: 'changed', baseBlobSha: linkBlob }],
      }),
    ).rejects.toThrow();
    await expect(provider.commit({ ...commitInput(), changes: [draft(), draft()] })).rejects.toThrow();
    await assertCleanedUp();
    await assertCloneUsable();
  });

  it('rejects clone paths outside the configured repository directory, including symlink aliases', async () => {
    const outside = path.join(dataDir, 'outside');
    await git.run(['clone', '--', REMOTE, outside], { auth: AUTH });
    const alias = path.join(reposDir, 'alias');
    await fs.symlink(outside, alias);
    for (const candidate of [outside, alias]) {
      await expect(provider.commit({ ...commitInput(), cloneDir: candidate })).rejects.toThrow();
    }
    await assertCleanedUp();
    await assertCloneUsable();
  });

  it('cleans registered temporary worktrees after commit failure and allows a subsequent commit', async () => {
    git.beforeRun = (args) => {
      if (args.includes('commit')) {
        git.beforeRun = undefined;
        throw new GitOperationError('unknown', 'Injected commit failure.');
      }
    };
    await expect(provider.commit(commitInput())).rejects.toThrow('Injected commit failure');
    expect(git.calls.some((args) => args.includes('worktree') && args.includes('add'))).toBe(true);
    await assertCleanedUp();
    await assertCloneUsable();
    expect((await provider.commit(commitInput())).parents).toEqual([headSha]);
    await assertCleanedUp();
  });

  it('cleans up when worktree creation registers state and then fails', async () => {
    git.afterRun = (args) => {
      if (args.includes('worktree') && args.includes('add')) {
        git.afterRun = undefined;
        throw new GitOperationError('unknown', 'Injected worktree creation failure.');
      }
    };
    await expect(provider.commit(commitInput())).rejects.toThrow('Injected worktree creation failure');
    await assertCleanedUp();
    await assertCloneUsable();
    await provider.commit(commitInput());
    await assertCleanedUp();
  });

  it('recovers from a failed first worktree removal without leaving registrations or draft files', async () => {
    git.beforeRun = (args) => {
      if (args.includes('worktree') && args.includes('remove')) {
        git.beforeRun = undefined;
        throw new GitOperationError('unknown', 'Injected worktree removal failure.');
      }
    };
    const committed = await provider.commit(commitInput());
    expect(committed.parents).toEqual([headSha]);
    await assertCleanedUp();
    await assertCloneUsable();
  });

  it('cleans up after cancellation without passing the cancelled signal to cleanup', async () => {
    const abort = new AbortController();
    git.afterRun = (args) => {
      if (args.includes('worktree') && args.includes('add')) {
        git.afterRun = undefined;
        abort.abort();
      }
    };
    await expect(provider.commit({ ...commitInput(), signal: abort.signal })).rejects.toThrow();
    await assertCleanedUp();
    await assertCloneUsable();
  });

  it('rejects concurrent mutations from separate provider instances and preserves the winner', async () => {
    let started!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    git.beforeRun = async (args) => {
      if (args.includes('worktree') && args.includes('add')) {
        git.beforeRun = undefined;
        started();
        await held;
      }
    };
    const winner = provider.commit(commitInput());
    await entered;
    try {
      const other = new HttpGitProvider(BUILTIN_GIT_PROVIDERS[0]!, git, 'x-access-token', reposDir);
      await expect(other.commit(commitInput())).rejects.toMatchObject({ kind: 'busy' });
      await expect(
        other.syncClone({ remoteUrl: REMOTE, branch: 'main', targetDir: cloneDir, auth: AUTH }),
      ).rejects.toMatchObject({ kind: 'busy' });
    } finally {
      release();
    }
    expect((await winner).parents).toEqual([headSha]);
    await assertCleanedUp();
    await assertCloneUsable();
  });
});

describe('remote protection and safe pushes', () => {
  it('detects a remote advancement and refuses a commit based on the old head', async () => {
    const advanced = server.commit(REPO, 'main', 'README.md', '# Remote update\n');
    const branch = await provider.inspectBranch(connection());
    expect(branch.remoteHeadSha).toBe(advanced);
    await expect(provider.commit(commitInput())).rejects.toMatchObject({ kind: 'conflict' });
    expect(git.calls.some((args) => args.includes('worktree') && args.includes('add'))).toBe(false);
    await assertCleanedUp();
    await assertCloneUsable();
  });

  it('reports local/remote divergence and keeps local commits when the remote advances', async () => {
    const local = await provider.commit(commitInput());
    const advanced = server.commit(REPO, 'main', 'README.md', '# Remote update\n');
    expect(await provider.inspectBranch(connection())).toEqual({
      branch: 'main',
      localHeadSha: local.sha,
      remoteHeadSha: advanced,
      ahead: 1,
      behind: 1,
    });
    await expect(
      provider.commit({
        ...commitInput(),
        expectedHeadSha: local.sha,
        changes: [{ path: 'next.md', content: 'next\n', baseBlobSha: null }],
      }),
    ).rejects.toMatchObject({ kind: 'conflict' });
    await expect(provider.push(pushInput(local.sha))).rejects.toMatchObject({ kind: 'conflict' });
    expect((await provider.getCommit(cloneDir, local.sha)).sha).toBe(local.sha);
    await assertCleanedUp();
    await assertCloneUsable();
  });

  it('pushes the known retained commit with authenticated smart HTTP and no force option', async () => {
    const committed = await provider.commit(commitInput());
    expect(await provider.push(pushInput(committed.sha))).toEqual(committed);
    expect(await provider.inspectBranch(connection())).toEqual({
      branch: 'main',
      localHeadSha: committed.sha,
      remoteHeadSha: committed.sha,
      ahead: 0,
      behind: 0,
    });
    const remote = await provider.testConnection(REMOTE, AUTH);
    expect(remote.branches).toEqual(['main']);
    const pushedHead = (
      await git.run(['ls-remote', '--', REMOTE, 'refs/heads/main'], { auth: AUTH })
    ).stdout.split('\t')[0];
    expect(pushedHead).toBe(committed.sha);
    const pushes = git.calls.filter((args) => args.includes('push'));
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.some((arg) => arg === '-f' || arg.startsWith('--force') || arg.startsWith('+'))).toBe(
      false,
    );
    expect(pushes[0]!.join(' ')).not.toContain(TOKEN);
    expect(server.requestUrls.join('\n')).not.toContain(TOKEN);
    expect(await fs.readFile(path.join(cloneDir, '.git/config'), 'utf8')).not.toMatch(
      /Authorization|extraheader/,
    );
    await assertCleanedUp();
    await assertCloneUsable();
  });

  it('rejects a remote race after the fetch through a real non-fast-forward push', async () => {
    const local = await provider.commit(commitInput());
    let advanced = '';
    git.beforeRun = (args) => {
      if (args.includes('push')) {
        git.beforeRun = undefined;
        advanced = server.commit(REPO, 'main', 'README.md', '# Raced remote update\n');
      }
    };
    await expect(provider.push(pushInput(local.sha))).rejects.toMatchObject({ kind: 'rejected' });
    expect(advanced).not.toBe('');
    expect((await provider.inspectBranch(connection())).remoteHeadSha).toBe(advanced);
    expect((await provider.getCommit(cloneDir, local.sha)).sha).toBe(local.sha);
    expect(git.calls.filter((args) => args.includes('push'))).toHaveLength(1);
    expect(
      git.calls
        .filter((args) => args.includes('push'))
        .flat()
        .some((arg) => arg === '-f' || arg.startsWith('--force') || arg.startsWith('+')),
    ).toBe(false);
    await assertCleanedUp();
    await assertCloneUsable();
  });

  it('surfaces real server rejection without leaking token, Basic auth or credential-bearing URLs', async () => {
    const local = await provider.commit(commitInput());
    const basic = Buffer.from(`${AUTH.username}:${TOKEN}`).toString('base64');
    const hook = path.join(server.root, REPO, 'hooks/pre-receive');
    await fs.writeFile(
      hook,
      `#!/bin/sh\nprintf '%s\\n' '${TOKEN}' 'Basic ${basic}' 'https://bot:${TOKEN}@git.test/private.git' >&2\nexit 1\n`,
      { mode: 0o700 },
    );
    const failure = await provider.push(pushInput(local.sha)).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(GitOperationError);
    expect(failure).toMatchObject({ kind: 'rejected' });
    const surfaced = String(failure);
    expect(surfaced).not.toContain(TOKEN);
    expect(surfaced).not.toContain(basic);
    expect(surfaced).not.toContain('https://bot:');
    expect((await provider.inspectBranch(connection())).remoteHeadSha).toBe(headSha);
    await fs.rm(hook);
    expect((await provider.push(pushInput(local.sha))).sha).toBe(local.sha);
    await assertCleanedUp();
    await assertCloneUsable();
  });

  it('refuses pushing arbitrary or superseded commits and invalid remotes before the push', async () => {
    const local = await provider.commit(commitInput());
    await expect(provider.push(pushInput(headSha))).rejects.toThrow();
    await expect(provider.push(pushInput('0'.repeat(40)))).rejects.toThrow();
    await expect(
      provider.push({ ...pushInput(local.sha), remoteUrl: `https://bot:${TOKEN}@git.test/${REPO}` }),
    ).rejects.toThrow();
    await expect(
      provider.push({ ...pushInput(local.sha), remoteUrl: `http://git.test/${REPO}` }),
    ).rejects.toThrow();
    expect(git.calls.some((args) => args.includes('push'))).toBe(false);
    await assertCleanedUp();
    await assertCloneUsable();
  });
});
