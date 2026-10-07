import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitCli } from '@/server/providers/git/git-cli';
import { GitHistoryReader } from '@/server/providers/git/history-reader';

let dataDir: string;
let reposDir: string;
let cloneDir: string;
let git: GitCli;
let reader: GitHistoryReader;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stack-manager-history-'));
  reposDir = path.join(dataDir, 'repos');
  cloneDir = path.join(reposDir, 'repo');
  await fs.mkdir(cloneDir, { recursive: true });
  git = new GitCli({ homeDir: path.join(dataDir, 'git-home') });
  await run(['init', '--initial-branch=main']);
  reader = new GitHistoryReader(git, reposDir);
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

const run = (args: string[]) => git.run(args, { cwd: cloneDir });
const currentHead = async () => (await run(['rev-parse', 'HEAD'])).stdout.trim();
const page = { limit: 20, offset: 0 };

async function commit(files: Record<string, string | null>, message = 'Change sources') {
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(cloneDir, file);
    if (content === null) await fs.rm(target);
    else {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content);
    }
  }
  await run(['add', '--all']);
  await run([
    '-c',
    'user.name=Stack Operator',
    '-c',
    'user.email=operator@example.invalid',
    'commit',
    '-m',
    message,
  ]);
  return currentHead();
}

describe('Git history reader', () => {
  it('selects actual target paths, excludes another stack, and keeps all relevant files', async () => {
    const initial = await commit({ 'stacks/api/compose.yaml': 'one\n' });
    const another = await commit({ 'stacks/api-other/compose.yaml': 'other\n' }, 'api');
    const target = await commit({
      'stacks/api/compose.yaml': 'two\n',
      'stacks/api/config/app.json': '{}\n',
      'stacks/db/compose.yaml': 'db\n',
    });
    expect(await reader.listCommits(cloneDir, target, 'stacks/api', page)).toEqual({
      shas: [target, initial],
      hasMore: false,
    });
    expect(await reader.changedFiles(cloneDir, target, 'stacks/api')).toMatchObject([
      {
        path: 'stacks/api/compose.yaml',
        status: 'modified',
        before: { kind: 'file' },
        after: { kind: 'file' },
      },
      { path: 'stacks/api/config/app.json', status: 'added', before: null, after: { kind: 'file' } },
    ]);
    expect(await reader.listCommits(cloneDir, target, 'stacks/db', page)).toEqual({
      shas: [target],
      hasMore: false,
    });
    expect(await reader.listCommits(cloneDir, target, '', page)).toEqual({
      shas: [target, another, initial],
      hasMore: false,
    });
    expect(await reader.listCommits(cloneDir, target, 'stacks/api/config', page)).toEqual({
      shas: [target],
      hasMore: false,
    });
    expect(await reader.listCommits(cloneDir, target, 'missing', page)).toEqual({ shas: [], hasMore: false });
    expect(await reader.changedFiles(cloneDir, initial, 'stacks/api')).toMatchObject([
      { path: 'stacks/api/compose.yaml', status: 'added', before: null },
    ]);
  });

  it('paginates matching commits with a retained head, excluding empty commits', async () => {
    const first = await commit({ 'nested/stack/compose.yaml': 'first\n' });
    const second = await commit({ 'nested/stack/compose.yaml': 'second\n' });
    await run([
      '-c',
      'user.name=Stack Operator',
      '-c',
      'user.email=operator@example.invalid',
      'commit',
      '--allow-empty',
      '-m',
      'Empty',
    ]);
    const third = await commit({ 'nested/stack/compose.yaml': 'third\n' });
    for (const root of ['', 'nested/stack']) {
      expect(await reader.listCommits(cloneDir, third, root, { limit: 1, offset: 0 })).toEqual({
        shas: [third],
        hasMore: true,
      });
      expect(await reader.listCommits(cloneDir, third, root, { limit: 1, offset: 1 })).toEqual({
        shas: [second],
        hasMore: true,
      });
      expect(await reader.listCommits(cloneDir, third, root, { limit: 1, offset: 2 })).toEqual({
        shas: [first],
        hasMore: false,
      });
      expect(await reader.listCommits(cloneDir, third, root, { limit: 1, offset: 3 })).toEqual({
        shas: [],
        hasMore: false,
      });
      expect(await reader.listCommits(cloneDir, second, root, page)).toEqual({
        shas: [second, first],
        hasMore: false,
      });
    }
  });

  it('reports deletions and represents renames as deletion plus addition', async () => {
    await commit({ 'stack/old.yaml': 'original\n', 'stack/remove.yaml': 'remove\n' });
    const deletion = await commit({ 'stack/remove.yaml': null });
    expect(await reader.changedFiles(cloneDir, deletion, 'stack')).toMatchObject([
      { path: 'stack/remove.yaml', status: 'deleted', before: { kind: 'file' }, after: null },
    ]);
    const rename = await commit({ 'stack/old.yaml': null, 'another/new.yaml': 'original\n' });
    expect(await reader.changedFiles(cloneDir, rename, '')).toMatchObject([
      { path: 'another/new.yaml', status: 'added', before: null },
      { path: 'stack/old.yaml', status: 'deleted', after: null },
    ]);
    expect((await reader.listCommits(cloneDir, rename, 'stack', page)).shas[0]).toBe(rename);
    expect((await reader.listCommits(cloneDir, rename, 'another', page)).shas).toEqual([rename]);
  });

  it('treats wildcard-looking roots literally', async () => {
    const literal = await commit({ 'stack[1]/compose.yaml': 'literal\n' });
    const other = await commit({ 'stack1/compose.yaml': 'other\n' });
    expect(await reader.listCommits(cloneDir, other, 'stack[1]', page)).toEqual({
      shas: [literal],
      hasMore: false,
    });
    expect(await reader.changedFiles(cloneDir, other, 'stack[1]')).toEqual([]);
  });

  it('retains unusual raw filenames as metadata alongside ordinary paths', async () => {
    const unusual = 'stack/\nodd\\file ';
    const head = await commit({ [unusual]: 'unusual\n', 'stack/compose.yaml': 'ordinary\n' });
    expect(await reader.listCommits(cloneDir, head, 'stack', page)).toEqual({ shas: [head], hasMore: false });
    expect((await reader.changedFiles(cloneDir, head, 'stack')).map((change) => change.path)).toEqual([
      unusual,
      'stack/compose.yaml',
    ]);
  });

  it('includes side-branch commits and only first-parent relevant merge changes', async () => {
    const initial = await commit({ 'stack/compose.yaml': 'base\n', 'other/compose.yaml': 'base\n' });
    await run(['checkout', '-b', 'feature']);
    const feature = await commit({ 'stack/compose.yaml': 'feature\n' });
    await run(['checkout', 'main']);
    const other = await commit({ 'other/compose.yaml': 'main\n' });
    await run([
      '-c',
      'user.name=Stack Operator',
      '-c',
      'user.email=operator@example.invalid',
      'merge',
      '--no-ff',
      'feature',
      '-m',
      'Merge feature',
    ]);
    const merge = await currentHead();
    expect((await reader.listCommits(cloneDir, merge, 'stack', page)).shas).toEqual([
      merge,
      feature,
      initial,
    ]);
    expect(await reader.changedFiles(cloneDir, merge, 'stack')).toMatchObject([
      { path: 'stack/compose.yaml', status: 'modified' },
    ]);
    expect(await reader.changedFiles(cloneDir, merge, 'other')).toEqual([]);
    expect((await reader.listCommits(cloneDir, merge, 'other', page)).shas).toEqual([other, initial]);
    expect(await reader.listCommits(cloneDir, merge, 'other', { limit: 1, offset: 1 })).toEqual({
      shas: [initial],
      hasMore: false,
    });
    expect(await reader.isAncestor(cloneDir, feature, merge)).toBe(true);
    expect(await reader.isAncestor(cloneDir, merge, feature)).toBe(false);
  });

  it('returns metadata with multiline delimiter-looking content and declared legacy encoding', async () => {
    const message = 'Subject <script>\n\nBody\x1e%x00\nSecond line';
    const head = await commit({ 'compose.yaml': 'source\n' }, message);
    expect(await reader.readCommit(cloneDir, head)).toMatchObject({
      sha: head,
      parents: [],
      message: message + '\n',
      author: { name: 'Stack Operator', email: 'operator@example.invalid' },
    });
    const tree = (await run(['rev-parse', `${head}^{tree}`])).stdout.trim();
    const objectFile = path.join(dataDir, 'commit-object');
    const raw = `tree ${tree}\nparent ${head}\nauthor Ren\xe9 <rene@example.invalid> 1700000000 +0000\ncommitter Ren\xe9 <rene@example.invalid> 1700000000 +0000\nencoding ISO-8859-1\n\nCaf\xe9\n\nLegacy body\n`;
    await fs.writeFile(objectFile, Buffer.from(raw, 'latin1'));
    const legacy = (await run(['hash-object', '-t', 'commit', '-w', objectFile])).stdout.trim();
    expect(await reader.readCommit(cloneDir, legacy)).toMatchObject({
      sha: legacy,
      message: 'Café\n\nLegacy body\n',
      author: { name: 'René', email: 'rene@example.invalid' },
    });
  });

  it('preserves embedded NUL message content without confusing fixed metadata fields', async () => {
    const head = await commit({ 'compose.yaml': 'source\n' });
    const tree = (await run(['rev-parse', `${head}^{tree}`])).stdout.trim();
    const objectFile = path.join(dataDir, 'commit-object');
    await fs.writeFile(
      objectFile,
      `tree ${tree}\nparent ${head}\nauthor Operator <op@example.invalid> 1700000000 +0000\ncommitter Operator <op@example.invalid> 1700000000 +0000\n\nSubject\n\nBefore\0after\n`,
    );
    const sha = (await run(['hash-object', '-t', 'commit', '--literally', '-w', objectFile])).stdout.trim();
    expect(await reader.readCommit(cloneDir, sha)).toMatchObject({
      sha,
      message: 'Subject\n\nBefore\0after\n',
    });
  });

  it('returns object sizes and identifies symlinks and type changes without reading their targets', async () => {
    const initial = await commit({ 'stack/file': 'four' });
    const initialChange = (await reader.changedFiles(cloneDir, initial, 'stack'))[0]!;
    expect(await reader.objectSize(cloneDir, initialChange.after!.objectSha)).toBe(4);
    await fs.rm(path.join(cloneDir, 'stack/file'));
    await fs.symlink('../../outside', path.join(cloneDir, 'stack/file'));
    await run(['add', '--all']);
    await run([
      '-c',
      'user.name=Stack Operator',
      '-c',
      'user.email=operator@example.invalid',
      'commit',
      '-m',
      'Type change',
    ]);
    expect(await reader.changedFiles(cloneDir, await currentHead(), 'stack')).toMatchObject([
      { path: 'stack/file', status: 'type_changed', before: { kind: 'file' }, after: { kind: 'symlink' } },
    ]);
  });

  it('rejects unsafe inputs and noncommit objects', async () => {
    const head = await commit({ 'compose.yaml': 'source\n' });
    for (const root of ['../stack', '/stack', './stack', 'stack/', '.git', 'stack\0bad']) {
      await expect(reader.listCommits(cloneDir, head, root, page)).rejects.toThrow();
      await expect(reader.changedFiles(cloneDir, head, root)).rejects.toThrow();
    }
    for (const invalidPage of [
      { limit: 0, offset: 0 },
      { limit: 51, offset: 0 },
      { limit: 1.5, offset: 0 },
      { limit: 1, offset: -1 },
      { limit: 1, offset: 10001 },
    ]) {
      await expect(reader.listCommits(cloneDir, head, '', invalidPage)).rejects.toThrow();
    }
    for (const sha of ['HEAD', head.slice(0, 7), '--all']) {
      await expect(reader.readCommit(cloneDir, sha)).rejects.toThrow();
      await expect(reader.listCommits(cloneDir, sha, '', page)).rejects.toThrow();
      await expect(reader.isAncestor(cloneDir, sha, head)).rejects.toThrow();
      await expect(reader.objectSize(cloneDir, sha)).rejects.toThrow();
    }
    const blob = (await reader.changedFiles(cloneDir, head, ''))[0]!.after!.objectSha;
    await expect(reader.readCommit(cloneDir, blob)).rejects.toThrow();
    await expect(reader.listCommits(cloneDir, blob, '', page)).rejects.toThrow();
    expect(await reader.isAncestor(cloneDir, blob, head)).toBe(false);
    expect(await reader.isAncestor(cloneDir, 'a'.repeat(40), head)).toBe(false);
    expect(await reader.isAncestor(cloneDir, head, 'a'.repeat(40))).toBe(false);
    await expect(reader.readCommit(path.join(dataDir, 'outside'), head)).rejects.toThrow();
  });

  it('rejects truncated or malformed Git output instead of returning partial history', async () => {
    const head = await commit({ 'compose.yaml': 'source\n' });
    const realRun = git.run.bind(git);
    const spy = vi.spyOn(git, 'run').mockImplementation(async (args, options) => {
      const output = await realRun(args, options);
      return args[0] === 'log' ? { ...output, truncated: true } : output;
    });
    await expect(reader.listCommits(cloneDir, head, '', page)).rejects.toThrow();
    spy.mockImplementation(async (args, options) => {
      const output = await realRun(args, options);
      return args[0] === 'diff-tree' ? { ...output, stdout: output.stdout.slice(0, -1) } : output;
    });
    await expect(reader.changedFiles(cloneDir, head, '')).rejects.toThrow();
    spy.mockRestore();
  });

  it('bounds changed files per commit', async () => {
    const files = Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`stack/${i}.yaml`, 'source\n']));
    const head = await commit(files);
    await expect(reader.changedFiles(cloneDir, head, 'stack')).rejects.toThrow();
  });
});
