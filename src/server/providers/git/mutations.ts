import fs from 'node:fs/promises';
import path from 'node:path';
import { MAX_EDITABLE_BYTES } from '@/server/domain/draft';
import { normalizeRemoteUrl, validateBranchName } from '@/server/domain/git-repository';
import { resolveRealWithin } from '@/server/security/paths';
import { isSecretPath, normalizeRepoPath } from '@/shared/source/paths';
import type { GitCli } from './git-cli';
import { resolveRepositoryDir, withRepositoryLock } from './repository-lock';
import { GitSourceReader } from './source-reader';
import {
  GitOperationError,
  type GitBranchInput,
  type GitBranchState,
  type GitCommitInput,
  type GitCommitMetadata,
  type GitPushInput,
} from './types';

const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const localRef = (branch: string) => `refs/stack-manager/heads/${branch}`;

/** Internal implementation shared by the smart-HTTP forge adapters. */
export class GitMutations {
  private readonly reader: GitSourceReader;

  constructor(
    private readonly git: GitCli,
    private readonly reposDir: string,
  ) {
    this.reader = new GitSourceReader(git);
  }

  async inspectBranch(input: GitBranchInput): Promise<GitBranchState> {
    validateInput(input);
    return withRepositoryLock(this.reposDir, input.cloneDir, (dir) =>
      this.fetchState({ ...input, cloneDir: dir }),
    );
  }

  async commit(input: GitCommitInput): Promise<GitCommitMetadata> {
    validateInput(input);
    assertSha(input.expectedHeadSha);
    if (
      !input.message.trim() ||
      input.message.includes('\0') ||
      Buffer.byteLength(input.message) > 64 * 1024
    ) {
      throw new GitOperationError('invalid', 'A commit message of at most 64 KiB is required.');
    }
    if (
      !input.author.name.trim() ||
      !input.author.email.trim() ||
      /[\u0000-\u001f\u007f<>]/.test(input.author.name + input.author.email)
    ) {
      throw new GitOperationError('invalid', 'A printable author name and email are required.');
    }
    if (!input.changes.length) throw new GitOperationError('invalid', 'Select at least one file change.');
    const paths = new Set<string>();
    for (const change of input.changes) {
      if (
        normalizeRepoPath(change.path) !== change.path ||
        isSecretPath(change.path) ||
        paths.has(change.path)
      ) {
        throw new GitOperationError('invalid', 'Changes require unique, canonical, non-secret file paths.');
      }
      paths.add(change.path);
      if (change.baseBlobSha !== null) assertSha(change.baseBlobSha);
      if (
        change.content !== null &&
        (change.content.includes('\0') || Buffer.byteLength(change.content) > MAX_EDITABLE_BYTES)
      ) {
        throw new GitOperationError('invalid', 'Changes must be text files of at most 1 MiB.');
      }
    }
    return withRepositoryLock(this.reposDir, input.cloneDir, async (dir) => {
      const retained = await this.retainedHead(dir, input.branch);
      const state = await this.fetchState({ ...input, cloneDir: dir });
      if (state.localHeadSha !== input.expectedHeadSha || state.behind > 0) {
        throw new GitOperationError(
          'conflict',
          'The branch has changed. Fetch and review the drafts before committing.',
        );
      }
      const entries = await this.reader.listTree(dir, input.expectedHeadSha);
      const tree = new Map(entries.map((entry) => [entry.path, entry]));
      for (const change of input.changes) {
        const entry = tree.get(change.path);
        if ((entry?.objectSha ?? null) !== change.baseBlobSha) {
          throw new GitOperationError(
            'conflict',
            'A selected draft is outdated. Review its current base before committing.',
          );
        }
        if ((entry && entry.kind !== 'file') || (change.content === null && !entry)) {
          throw new GitOperationError('invalid', 'Only regular files can be changed or deleted.');
        }
        // Refuse file/directory collisions, including symlink and submodule ancestors.
        // ponytail: scan the bounded source tree per selected file; index prefixes if large selections become slow.
        for (const existing of tree.keys()) {
          if (existing.startsWith(`${change.path}/`) || change.path.startsWith(`${existing}/`)) {
            throw new GitOperationError('invalid', 'A selected path conflicts with an existing tree entry.');
          }
        }
        for (const selected of paths) {
          if (selected !== change.path && selected.startsWith(`${change.path}/`)) {
            throw new GitOperationError('invalid', 'Selected file paths overlap.');
          }
        }
      }
      const parent = await fs.mkdtemp(path.join(path.dirname(dir), '.mutation-'));
      const worktree = path.join(parent, 'tree');
      let commit: GitCommitMetadata;
      try {
        // No repository files are checked out: secret files and symlinks never reach this workspace.
        await this.git.run(
          ['worktree', 'add', '--detach', '--no-checkout', '--', worktree, input.expectedHeadSha],
          { cwd: dir, signal: input.signal },
        );
        await this.git.run(['read-tree', input.expectedHeadSha], { cwd: worktree, signal: input.signal });
        for (const change of input.changes) {
          if (change.content === null) {
            await this.git.run(['update-index', '--force-remove', '--', change.path], {
              cwd: worktree,
              signal: input.signal,
            });
            continue;
          }
          const file = resolveRealWithin(worktree, change.path);
          await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
          await fs.writeFile(file, change.content, { flag: 'wx', mode: 0o600 });
          // Stage exact bytes without repository-controlled clean filters or pathspec interpretation.
          const { stdout } = await this.git.run(['hash-object', '--no-filters', '-w', '--', file], {
            cwd: worktree,
            signal: input.signal,
          });
          const blob = stdout.trim();
          assertSha(blob);
          const mode = tree.get(change.path)?.executable ? '100755' : '100644';
          await this.git.run(['update-index', '--add', '--cacheinfo', mode, blob, change.path], {
            cwd: worktree,
            signal: input.signal,
          });
        }
        const messageFile = path.join(parent, 'message');
        await fs.writeFile(messageFile, input.message, { mode: 0o600 });
        await this.git.run(
          [
            '-c',
            `user.name=${input.author.name}`,
            '-c',
            `user.email=${input.author.email}`,
            'commit',
            '--no-gpg-sign',
            '--no-verify',
            '--cleanup=verbatim',
            '--file',
            messageFile,
          ],
          { cwd: worktree, signal: input.signal },
        );
        const { stdout } = await this.git.run(['rev-parse', '--verify', 'HEAD'], { cwd: worktree });
        commit = await this.getCommit(dir, stdout.trim());
      } finally {
        await this.cleanup(dir, worktree, parent);
      }
      // Publish only after cleanup; compare-and-swap also protects against unexpected ref changes.
      await this.git.run(
        [
          'update-ref',
          localRef(input.branch),
          commit.sha,
          retained ?? '0'.repeat(input.expectedHeadSha.length),
        ],
        { cwd: dir },
      );
      return commit;
    });
  }

  async push(input: GitPushInput): Promise<GitCommitMetadata> {
    validateInput(input);
    assertSha(input.commitSha);
    assertSha(input.expectedRemoteSha);
    return withRepositoryLock(this.reposDir, input.cloneDir, async (dir) => {
      const state = await this.fetchState({ ...input, cloneDir: dir });
      if ((await this.retainedHead(dir, input.branch)) !== input.commitSha) {
        throw new GitOperationError('conflict', 'The selected commit is not the retained local branch head.');
      }
      if (state.remoteHeadSha !== input.expectedRemoteSha || state.behind > 0) {
        throw new GitOperationError(
          'conflict',
          'The remote branch has changed. Fetch and review it before pushing.',
        );
      }
      const commit = await this.getCommit(dir, input.commitSha);
      await this.git.run(
        [
          'push',
          '--porcelain',
          '--no-follow-tags',
          '--no-mirror',
          '--',
          input.remoteUrl,
          `${input.commitSha}:refs/heads/${input.branch}`,
        ],
        { cwd: dir, auth: input.auth, signal: input.signal },
      );
      return commit;
    });
  }

  async getCommit(cloneDir: string, commitSha: string): Promise<GitCommitMetadata> {
    assertSha(commitSha);
    // Metadata reads also enforce containment, but do not take the mutation lock.
    const dir = await resolveRepositoryDir(this.reposDir, cloneDir);
    const { stdout: objectType } = await this.git.run(['cat-file', '-t', commitSha], { cwd: dir });
    if (objectType.trim() !== 'commit') {
      throw new GitOperationError('invalid', 'Commit metadata requires a commit object.');
    }
    const { stdout, truncated } = await this.git.run(
      ['show', '--no-patch', '--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%B', commitSha],
      { cwd: dir },
    );
    if (truncated) throw new GitOperationError('invalid', 'Commit metadata is too large.');
    const [sha, parents, name, email, authoredAt, committerName, committerEmail, committedAt, ...message] =
      stdout.split('\0');
    if (!sha || !OBJECT_ID.test(sha) || authoredAt === undefined || committedAt === undefined)
      throw new GitOperationError('invalid', 'Invalid commit metadata.');
    return {
      sha,
      parents: parents ? parents.split(' ') : [],
      author: { name: name!, email: email! },
      committer: { name: committerName!, email: committerEmail! },
      authoredAt,
      committedAt,
      message: message.join('\0').replace(/\n$/, ''),
    };
  }

  private async retainedHead(dir: string, branch: string): Promise<string | null> {
    const ref = localRef(branch);
    const { stdout } = await this.git.run(['for-each-ref', '--format=%(refname)%00%(objectname)', ref], {
      cwd: dir,
    });
    return (
      stdout
        .split('\n')
        .find((line) => line.startsWith(`${ref}\0`))
        ?.split('\0')[1] ?? null
    );
  }

  private async fetchState(input: GitBranchInput): Promise<GitBranchState> {
    const dir = input.cloneDir;
    const { stdout: cached } = await this.git.run(
      ['rev-parse', '--verify', `refs/remotes/origin/${input.branch}^{commit}`],
      { cwd: dir },
    );
    await this.git.run(
      [
        'fetch',
        '--no-tags',
        '--',
        input.remoteUrl,
        `+refs/heads/${input.branch}:refs/remotes/origin/${input.branch}`,
      ],
      { cwd: dir, auth: input.auth, signal: input.signal },
    );
    const { stdout: remote } = await this.git.run(
      ['rev-parse', '--verify', `refs/remotes/origin/${input.branch}^{commit}`],
      { cwd: dir },
    );
    const remoteHeadSha = remote.trim();
    const localHeadSha = (await this.retainedHead(dir, input.branch)) ?? cached.trim();
    const { stdout } = await this.git.run(
      ['rev-list', '--left-right', '--count', `${localHeadSha}...${remoteHeadSha}`],
      { cwd: dir },
    );
    const [ahead, behind] = stdout.trim().split(/\s+/).map(Number);
    return { branch: input.branch, localHeadSha, remoteHeadSha, ahead: ahead!, behind: behind! };
  }

  private async cleanup(dir: string, worktree: string, parent: string): Promise<void> {
    try {
      await this.git.run(['worktree', 'remove', '--force', '--', worktree], { cwd: dir });
    } catch {
      // Addition may fail before registration, or removal may fail with a missing/partial checkout.
      // Retry only our worktree; never prune unrelated worktree registrations.
      const { stdout } = await this.git.run(['worktree', 'list', '--porcelain', '-z'], { cwd: dir });
      await fs.rm(worktree, { recursive: true, force: true });
      if (stdout.split('\0').includes(`worktree ${worktree}`)) {
        await this.git.run(['worktree', 'remove', '--force', '--', worktree], { cwd: dir });
      }
    }
    await fs.rm(parent, { recursive: true, force: true });
  }
}

function assertSha(sha: string): void {
  if (!OBJECT_ID.test(sha)) throw new GitOperationError('invalid', 'Invalid object id.');
}

function validateInput(input: GitBranchInput): void {
  if (
    normalizeRemoteUrl(input.remoteUrl) !== input.remoteUrl ||
    validateBranchName(input.branch) !== input.branch
  ) {
    throw new GitOperationError('invalid', 'A canonical remote URL and branch are required.');
  }
}
