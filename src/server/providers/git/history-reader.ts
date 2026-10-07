import { isWithin, normalizeRepoPath } from '@/shared/source/paths';
import type { GitCli } from './git-cli';
import { resolveRepositoryDir } from './repository-lock';
import {
  GitOperationError,
  type GitCommitMetadata,
  type HistoryFileChange,
  type HistoryObject,
  type HistoryReader,
} from './types';

const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const MAX_CHANGED_FILES = 500;
const TIMEOUT_MS = 30_000;

/** Native path-filtered history without walking or retaining the entire history in application memory. */
export class GitHistoryReader implements HistoryReader {
  constructor(
    private readonly git: GitCli,
    private readonly reposDir: string,
  ) {}

  async listCommits(
    cloneDir: string,
    headSha: string,
    root: string,
    page: { limit: number; offset: number },
  ) {
    assertSha(headSha);
    assertRoot(root);
    if (
      !Number.isInteger(page.limit) ||
      page.limit < 1 ||
      page.limit > 50 ||
      !Number.isInteger(page.offset) ||
      page.offset < 0 ||
      page.offset > 10_000
    ) {
      throw new GitOperationError('invalid', 'Invalid history page.');
    }
    const dir = await resolveRepositoryDir(this.reposDir, cloneDir);
    await this.assertCommit(dir, headSha);
    const { stdout, truncated } = await this.git.run(
      [
        'log',
        '--full-history',
        '--diff-merges=first-parent',
        '--diff-filter=ADMT',
        '--no-renames',
        '--root',
        '--format=%H',
        '--no-patch',
        // ponytail: Git skips before filtering; read at most 10,051 SHAs. Stream matching commits if deeper pages matter.
        `--max-count=${page.offset + page.limit + 1}`,
        headSha,
        '--',
        ...pathspec(root),
      ],
      { cwd: dir, timeoutMs: TIMEOUT_MS, maxOutputBytes: 1024 * 1024 },
    );
    const shas = stdout === '' ? [] : stdout.trimEnd().split('\n');
    if (truncated || shas.length > page.offset + page.limit + 1 || shas.some((sha) => !OBJECT_ID.test(sha))) {
      throw new GitOperationError('invalid', 'Invalid or oversized history output.');
    }
    return {
      shas: shas.slice(page.offset, page.offset + page.limit),
      hasMore: shas.length > page.offset + page.limit,
    };
  }

  async readCommit(cloneDir: string, sha: string): Promise<GitCommitMetadata> {
    assertSha(sha);
    const dir = await resolveRepositoryDir(this.reposDir, cloneDir);
    const raw = await this.git.run(['cat-file', 'commit', sha], {
      cwd: dir,
      timeoutMs: TIMEOUT_MS,
      maxOutputBytes: 64 * 1024,
    });
    const boundary = raw.stdout.indexOf('\n\n');
    if (raw.truncated || boundary === -1 || raw.stdout.slice(0, boundary).includes('\0'))
      throw new GitOperationError('invalid', 'Invalid or oversized commit metadata.');
    const { stdout, truncated } = await this.git.run(
      [
        'show',
        '--no-patch',
        '--encoding=UTF-8',
        '--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%B',
        sha,
      ],
      { cwd: dir, timeoutMs: TIMEOUT_MS, maxOutputBytes: 64 * 1024 },
    );
    const [
      objectSha,
      parents,
      name,
      email,
      authoredAt,
      committerName,
      committerEmail,
      committedAt,
      ...message
    ] = stdout.split('\0');
    const parentShas = parents ? parents.split(' ') : [];
    if (
      truncated ||
      objectSha !== sha ||
      parentShas.some((parent) => !OBJECT_ID.test(parent)) ||
      name === undefined ||
      email === undefined ||
      committerName === undefined ||
      committerEmail === undefined ||
      !authoredAt ||
      !committedAt ||
      !Number.isFinite(Date.parse(authoredAt)) ||
      !Number.isFinite(Date.parse(committedAt)) ||
      message.length === 0
    ) {
      throw new GitOperationError('invalid', 'Invalid or oversized commit metadata.');
    }
    const rawMessage = raw.stdout.slice(boundary + 2);
    const encoding = /^encoding (.+)$/m.exec(raw.stdout.slice(0, boundary))?.[1];
    if (rawMessage.includes('\0') && encoding && !/^utf-?8$/i.test(encoding))
      throw new GitOperationError('invalid', 'Unsupported commit message encoding.');
    return {
      sha,
      parents: parentShas,
      author: { name, email },
      committer: { name: committerName, email: committerEmail },
      authoredAt,
      committedAt,
      message: rawMessage.includes('\0') ? rawMessage : message.join('\0').replace(/\n$/, ''),
    };
  }

  async changedFiles(cloneDir: string, sha: string, root: string): Promise<HistoryFileChange[]> {
    assertSha(sha);
    assertRoot(root);
    const dir = await resolveRepositoryDir(this.reposDir, cloneDir);
    const commit = await this.readCommit(dir, sha);
    const { stdout, truncated } = await this.git.run(
      [
        'diff-tree',
        '--no-commit-id',
        '--raw',
        '-z',
        '-r',
        '--no-renames',
        '--no-abbrev',
        '--root',
        ...(commit.parents[0] ? [commit.parents[0], sha] : [sha]),
        '--',
        ...pathspec(root),
      ],
      { cwd: dir, timeoutMs: TIMEOUT_MS, maxOutputBytes: 1024 * 1024 },
    );
    if (truncated || (stdout !== '' && !stdout.endsWith('\0'))) {
      throw new GitOperationError('invalid', 'Invalid or oversized commit changes.');
    }
    const records = stdout === '' ? [] : stdout.slice(0, -1).split('\0');
    if (records.length % 2 !== 0 || records.length / 2 > MAX_CHANGED_FILES) {
      throw new GitOperationError('invalid', 'Invalid or oversized commit changes.');
    }
    const changes: HistoryFileChange[] = [];
    for (let index = 0; index < records.length; index += 2) {
      const match =
        /^:(\d{6}) (\d{6}) ([0-9a-f]{40}(?:[0-9a-f]{24})?) ([0-9a-f]{40}(?:[0-9a-f]{24})?) ([ADMT])$/.exec(
          records[index]!,
        );
      const file = records[index + 1]!;
      if (!match || !file || !isWithin(root, file))
        throw new GitOperationError('invalid', 'Invalid commit change.');
      const [, beforeMode, afterMode, beforeSha, afterSha, status] = match;
      const before = parseObject(beforeMode!, beforeSha!);
      const after = parseObject(afterMode!, afterSha!);
      if (
        (status === 'A' && (before !== null || after === null)) ||
        (status === 'D' && (before === null || after !== null)) ||
        ((status === 'M' || status === 'T') && (before === null || after === null))
      ) {
        throw new GitOperationError('invalid', 'Invalid commit change.');
      }
      changes.push({
        path: file,
        status: ({ A: 'added', M: 'modified', D: 'deleted', T: 'type_changed' } as const)[
          status as 'A' | 'M' | 'D' | 'T'
        ],
        before,
        after,
      });
    }
    return changes;
  }

  async isAncestor(cloneDir: string, sha: string, headSha: string): Promise<boolean> {
    assertSha(sha);
    assertSha(headSha);
    const dir = await resolveRepositoryDir(this.reposDir, cloneDir);
    if (!(await this.isCommit(dir, sha)) || !(await this.isCommit(dir, headSha))) return false;
    const { stdout, truncated } = await this.git.run(
      ['rev-list', '--max-count=1', sha, '--not', headSha, '--'],
      { cwd: dir, timeoutMs: TIMEOUT_MS, maxOutputBytes: 1024 },
    );
    if (truncated || (stdout.trim() !== '' && !OBJECT_ID.test(stdout.trim())))
      throw new GitOperationError('invalid', 'Invalid reachability output.');
    return stdout === '';
  }

  async objectSize(cloneDir: string, objectSha: string): Promise<number> {
    assertSha(objectSha);
    const dir = await resolveRepositoryDir(this.reposDir, cloneDir);
    const { stdout, truncated } = await this.git.run(['cat-file', '-s', objectSha], {
      cwd: dir,
      timeoutMs: TIMEOUT_MS,
      maxOutputBytes: 1024,
    });
    const size = Number(stdout.trim());
    if (truncated || !/^\d+\n$/.test(stdout) || !Number.isSafeInteger(size))
      throw new GitOperationError('invalid', 'Invalid object size.');
    return size;
  }

  private async assertCommit(dir: string, sha: string) {
    if (!(await this.isCommit(dir, sha)))
      throw new GitOperationError('invalid', 'History requires a commit object.');
  }

  private async isCommit(dir: string, sha: string): Promise<boolean> {
    try {
      const { stdout, truncated } = await this.git.run(['cat-file', '-t', sha], {
        cwd: dir,
        timeoutMs: TIMEOUT_MS,
        maxOutputBytes: 1024,
      });
      if (truncated || !/^(blob|tree|commit|tag)\n$/.test(stdout))
        throw new GitOperationError('invalid', 'Invalid object type.');
      return stdout === 'commit\n';
    } catch (error) {
      if (error instanceof GitOperationError && (error.kind === 'unknown' || error.kind === 'not_found'))
        return false;
      throw error;
    }
  }
}

function assertSha(sha: string) {
  if (!OBJECT_ID.test(sha)) throw new GitOperationError('invalid', 'Invalid commit or object id.');
}

function assertRoot(root: string) {
  try {
    if (normalizeRepoPath(root, { allowRoot: true }) !== root) throw new Error();
  } catch {
    throw new GitOperationError('invalid', 'Invalid history root.');
  }
}

function pathspec(root: string): string[] {
  return root === '' ? [] : [`:(top,literal)${root}`];
}

function parseObject(mode: string, objectSha: string): HistoryObject | null {
  if (mode === '000000' && /^0+$/.test(objectSha)) return null;
  if (/^0+$/.test(objectSha) || !['100644', '100755', '120000', '160000'].includes(mode))
    throw new GitOperationError('invalid', 'Invalid changed object.');
  return { objectSha, kind: mode === '120000' ? 'symlink' : mode === '160000' ? 'submodule' : 'file' };
}
