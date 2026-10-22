import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitCli } from '@/server/providers/git/git-cli';
import { GitHistoryReader } from '@/server/providers/git/history-reader';
import { GitOperationError } from '@/server/providers/git/types';

let dataDir: string;
let cloneDir: string;
let git: GitCli;
let reader: GitHistoryReader;

const identity = ['-c', 'user.name=Stack Operator', '-c', 'user.email=operator@example.invalid'];
const run = (args: string[]) => git.run(args, { cwd: cloneDir });

async function commit(files: Record<string, string | null>) {
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(cloneDir, file);
    if (content === null) await fs.rm(target);
    else {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content);
    }
  }
  await run(['add', '--all']);
  await run([...identity, 'commit', '-m', 'Change sources']);
  return (await run(['rev-parse', 'HEAD'])).stdout.trim();
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stack-manager-routing-history-'));
  const reposDir = path.join(dataDir, 'repos');
  cloneDir = path.join(reposDir, 'repo');
  await fs.mkdir(cloneDir, { recursive: true });
  git = new GitCli({ homeDir: path.join(dataDir, 'git-home') });
  await run(['init', '--initial-branch=main']);
  reader = new GitHistoryReader(git, reposDir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('Git deployment routing comparison', () => {
  it('compares committed trees across a range, retaining deleted and renamed paths', async () => {
    const before = await commit({
      'stacks/api/compose.yaml': 'first\n',
      'stacks/old/config.yaml': 'move me\n',
      'stacks/db/deleted.yaml': 'delete me\n',
    });
    await commit({ 'stacks/api/compose.yaml': 'second\n' });
    const unusual = 'stacks/api/config $(ignored) "é".yaml';
    const after = await commit({
      'stacks/api/compose.yaml': 'third\n',
      'stacks/old/config.yaml': null,
      'stacks/new/config.yaml': 'move me\n',
      'stacks/db/deleted.yaml': null,
      [unusual]: 'new\n',
      'stacks/api/.env': 'not returned as content\n',
    });
    await fs.writeFile(path.join(cloneDir, 'uncommitted.yaml'), 'ignored\n');
    expect(await reader.compareCommits(cloneDir, before, after)).toEqual(
      [
        'stacks/api/.env',
        'stacks/api/compose.yaml',
        unusual,
        'stacks/db/deleted.yaml',
        'stacks/new/config.yaml',
        'stacks/old/config.yaml',
      ].sort(),
    );
    expect(await reader.compareCommits(cloneDir, after, after)).toEqual([]);
  });

  it('rejects invalid ids before Git and rejects missing or noncommit objects at either endpoint', async () => {
    const head = await commit({ 'compose.yaml': 'source\n' });
    const spy = vi.spyOn(git, 'run');
    for (const invalid of ['HEAD', head.slice(0, 7), '--all', 'a'.repeat(41)]) {
      await expect(reader.compareCommits(cloneDir, invalid, head)).rejects.toThrow(GitOperationError);
      await expect(reader.compareCommits(cloneDir, head, invalid)).rejects.toThrow(GitOperationError);
    }
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    const blob = (await run(['rev-parse', `${head}:compose.yaml`])).stdout.trim();
    const tree = (await run(['rev-parse', `${head}^{tree}`])).stdout.trim();
    for (const invalid of ['0'.repeat(40), blob, tree]) {
      await expect(reader.compareCommits(cloneDir, invalid, head)).rejects.toThrow(GitOperationError);
      await expect(reader.compareCommits(cloneDir, head, invalid)).rejects.toThrow(GitOperationError);
    }
    await expect(reader.compareCommits(dataDir, head, head)).rejects.toThrow();
  });

  it('rejects reverse and rewritten history', async () => {
    const base = await commit({ 'compose.yaml': 'base\n' });
    const main = await commit({ 'compose.yaml': 'main\n' });
    await run(['checkout', '-b', 'rewritten', base]);
    const rewritten = await commit({ 'compose.yaml': 'rewritten\n' });
    await expect(reader.compareCommits(cloneDir, main, base)).rejects.toThrow(GitOperationError);
    await expect(reader.compareCommits(cloneDir, main, rewritten)).rejects.toThrow(GitOperationError);
  });

  it.each(['stack/new\nline.yaml', 'stack/back\\slash.yaml', ' stack/compose.yaml'])(
    'rejects noncanonical committed paths: %j',
    async (file) => {
      const before = await commit({ 'compose.yaml': 'before\n' });
      const after = await commit({ [file]: 'after\n' });
      await expect(reader.compareCommits(cloneDir, before, after)).rejects.toThrow(GitOperationError);
    },
  );

  it('fails closed on truncated or malformed path and range output and deduplicates valid paths', async () => {
    const before = await commit({ 'compose.yaml': 'before\n' });
    const after = await commit({ 'compose.yaml': 'after\n' });
    const realRun = git.run.bind(git);
    const spy = vi.spyOn(git, 'run');
    for (const output of [
      { stdout: 'compose.yaml\0', truncated: true },
      { stdout: 'compose.yaml', truncated: false },
      { stdout: '\0', truncated: false },
      { stdout: '../outside\0', truncated: false },
      { stdout: '/absolute\0', truncated: false },
      { stdout: '.git/config\0', truncated: false },
      { stdout: `${'a'.repeat(1025)}\0`, truncated: false },
      { stdout: 'invalid\ufffd.yaml\0', truncated: false },
    ]) {
      spy.mockImplementation(async (args, options) => {
        const result = await realRun(args, options);
        return args[0] === 'diff-tree' ? { ...result, ...output } : result;
      });
      await expect(reader.compareCommits(cloneDir, before, after)).rejects.toThrow(GitOperationError);
    }
    for (const output of [
      { stdout: '1\n', truncated: true },
      { stdout: '1', truncated: false },
      { stdout: '-1\n', truncated: false },
      { stdout: '1001\n', truncated: false },
    ]) {
      spy.mockImplementation(async (args, options) => {
        const result = await realRun(args, options);
        return args.includes('--count') ? { ...result, ...output } : result;
      });
      await expect(reader.compareCommits(cloneDir, before, after)).rejects.toThrow(GitOperationError);
    }
    spy.mockImplementation(async (args, options) => {
      const result = await realRun(args, options);
      expect(options?.timeoutMs).toBe(30_000);
      expect(options?.maxOutputBytes).toBeGreaterThan(0);
      if (args[0] !== 'diff-tree') return result;
      expect(args).toContain('--no-renames');
      expect(args).toContain('-z');
      return { ...result, stdout: 'z.yaml\0a.yaml\0z.yaml\0' };
    });
    expect(await reader.compareCommits(cloneDir, before, after)).toEqual(['a.yaml', 'z.yaml']);
  });

  it('accepts 1,000 commits and rejects a longer range', async () => {
    const before = await commit({ 'compose.yaml': 'source\n' });
    const tree = (await run(['rev-parse', `${before}^{tree}`])).stdout.trim();
    let after = before;
    for (let i = 0; i < 1000; i++) {
      after = (
        await run([...identity, 'commit-tree', tree, '-p', after, '-m', 'Range commit'])
      ).stdout.trim();
    }
    expect(await reader.compareCommits(cloneDir, before, after)).toEqual([]);
    const oversized = (
      await run([...identity, 'commit-tree', tree, '-p', after, '-m', 'One too many'])
    ).stdout.trim();
    await expect(reader.compareCommits(cloneDir, before, oversized)).rejects.toThrow(GitOperationError);
  });

  it('accepts 10,000 paths and rejects larger comparisons without returning a partial result', async () => {
    const before = await commit({ 'compose.yaml': 'source\n' });
    const filesDir = path.join(cloneDir, 'files');
    await fs.mkdir(filesDir);
    for (let i = 0; i < 10_000; i++) await fs.writeFile(path.join(filesDir, `${i}.yaml`), 'source\n');
    const after = await commit({ 'files/0.yaml': 'source\n' });
    expect(await reader.compareCommits(cloneDir, before, after)).toHaveLength(10_000);
    const oversized = await commit({ 'files/extra.yaml': 'source\n' });
    await expect(reader.compareCommits(cloneDir, before, oversized)).rejects.toThrow(GitOperationError);
  });
});
