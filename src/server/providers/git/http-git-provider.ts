import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeRemoteUrl, validateBranchName } from '@/server/domain/git-repository';
import type { GitCli } from './git-cli';
import { GitMutations } from './mutations';
import { withRepositoryLock } from './repository-lock';
import {
  GitOperationError,
  type GitHttpAuth,
  type GitProvider,
  type GitProviderDescriptor,
  type RemoteProbe,
  type GitBranchInput,
  type GitCommitInput,
  type GitPushInput,
} from './types';

/**
 * GitProvider for forges reachable over smart-HTTP with token auth. GitHub, Gitea and Forgejo all
 * work with the same local `git` operations; they differ only in descriptor metadata today.
 * Forge-API features (PR creation, commit statuses, webhook parsing) arrive as per-forge
 * capabilities in later PRs.
 */
export class HttpGitProvider implements GitProvider {
  private readonly mutation: GitMutations;

  constructor(
    readonly descriptor: GitProviderDescriptor,
    private readonly git: GitCli,
    private readonly username = 'x-access-token',
    private readonly reposDir: string,
  ) {
    this.mutation = new GitMutations(git, reposDir);
  }

  defaultUsername(): string {
    return this.username;
  }

  async testConnection(
    remoteUrl: string,
    auth: GitHttpAuth | null,
    signal?: AbortSignal,
  ): Promise<RemoteProbe> {
    const { stdout } = await this.git.run(
      ['ls-remote', '--symref', '--', remoteUrl, 'HEAD', 'refs/heads/*'],
      {
        auth,
        signal,
        timeoutMs: 30_000,
      },
    );
    return parseLsRemote(stdout);
  }

  async syncClone(input: {
    remoteUrl: string;
    branch: string;
    targetDir: string;
    auth: GitHttpAuth | null;
    signal?: AbortSignal;
  }): Promise<{ headSha: string; cloned: boolean }> {
    normalizeRemoteUrl(input.remoteUrl);
    validateBranchName(input.branch);
    await fs.mkdir(this.reposDir, { recursive: true, mode: 0o700 });
    return withRepositoryLock(this.reposDir, input.targetDir, (targetDir) =>
      this.syncUnlocked({ ...input, targetDir }),
    );
  }

  private async syncUnlocked(input: {
    remoteUrl: string;
    branch: string;
    targetDir: string;
    auth: GitHttpAuth | null;
    signal?: AbortSignal;
  }): Promise<{ headSha: string; cloned: boolean }> {
    const { remoteUrl, branch, targetDir, auth, signal } = input;
    const exists = await isGitRepository(targetDir);
    if (exists) {
      await this.git.run(['remote', 'set-url', 'origin', '--', remoteUrl], { cwd: targetDir });
      await this.git.run(['fetch', '--prune', '--no-tags', 'origin', '+refs/heads/*:refs/remotes/origin/*'], {
        cwd: targetDir,
        auth,
        signal,
      });
    } else {
      await fs.mkdir(path.dirname(targetDir), { recursive: true, mode: 0o700 });
      const tmp = path.join(
        path.dirname(targetDir),
        `.tmp-${path.basename(targetDir)}-${randomBytes(6).toString('hex')}`,
      );
      try {
        await this.git.run(
          ['clone', '--no-tags', '--origin', 'origin', '--branch', branch, '--', remoteUrl, tmp],
          {
            auth,
            signal,
            timeoutMs: 15 * 60_000,
          },
        );
        await fs.rm(targetDir, { recursive: true, force: true });
        await fs.rename(tmp, targetDir);
      } catch (error) {
        await fs.rm(tmp, { recursive: true, force: true });
        throw error;
      }
    }
    const headSha = await this.resolveRemoteBranch(targetDir, branch);
    return { headSha, cloned: !exists };
  }

  inspectBranch(input: GitBranchInput) {
    return this.mutation.inspectBranch(input);
  }
  commit(input: GitCommitInput) {
    return this.mutation.commit(input);
  }
  push(input: GitPushInput) {
    return this.mutation.push(input);
  }
  getCommit(cloneDir: string, commitSha: string) {
    return this.mutation.getCommit(cloneDir, commitSha);
  }

  async listBranches(cloneDir: string): Promise<string[]> {
    const { stdout } = await this.git.run(
      ['for-each-ref', '--format=%(refname:strip=3)', 'refs/remotes/origin/'],
      {
        cwd: cloneDir,
      },
    );
    return stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && l !== 'HEAD')
      .sort();
  }

  private async resolveRemoteBranch(cloneDir: string, branch: string): Promise<string> {
    try {
      const { stdout } = await this.git.run(
        ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}^{commit}`],
        {
          cwd: cloneDir,
        },
      );
      return stdout.trim();
    } catch {
      throw new GitOperationError('invalid', 'The default branch does not exist on the remote.');
    }
  }
}

export function parseLsRemote(stdout: string): RemoteProbe {
  let defaultBranch: string | null = null;
  const branches: string[] = [];
  for (const line of stdout.split('\n')) {
    const symref = line.match(/^ref: refs\/heads\/(\S+)\tHEAD$/);
    if (symref?.[1]) {
      defaultBranch = symref[1];
      continue;
    }
    const ref = line.match(/^[0-9a-f]{40,64}\trefs\/heads\/(\S+)$/);
    if (ref?.[1]) branches.push(ref[1]);
  }
  return { defaultBranch, branches: branches.sort() };
}

async function isGitRepository(dir: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path.join(dir, '.git'));
    return stat.isDirectory();
  } catch {
    return false;
  }
}
