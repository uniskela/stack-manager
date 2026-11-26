import type { GitRepositoryConnection } from '@/server/domain/git-repository';
import { ConflictError, NotFoundError } from '@/server/domain/errors';
import type {
  GiteaImageUpdatePull,
  GiteaImageUpdatePullInput,
  GiteaImageUpdatePulls,
} from '@/server/providers/git/gitea-image-update-pulls';
import { scrubString } from '@/server/security/redact';
import type {
  ImageUpdatePullCheckStatus,
  ImageUpdatePullReview,
  ImageUpdatePullReviewList,
} from '@/shared/image-update-pull-review';
import type { AuditService } from './audit-service';
import type { GitRepositoryService } from './git-repository-service';
import type { GitRepositoryConnectionRepository } from './ports';

const PROPOSAL_BRANCH = /^stack-manager\/image-updates\/[a-f0-9]{32}$/;
const WIP_TITLE = /^\s*(?:WIP:|\[WIP\])/i;
const CHECK_ERRORS = {
  failure: 'Gitea checks failed for this pull request head.',
  pending: 'Gitea checks are pending for this pull request head.',
  missing: 'Gitea has no successful checks for this pull request head.',
};

function supportsReview(connection: GitRepositoryConnection): boolean {
  return connection.gitProviderType === 'gitea' && Boolean(connection.credentialId);
}

function isProposal(pull: GiteaImageUpdatePull, branch: string): boolean {
  return pull.sameRepository === true && pull.base === branch && PROPOSAL_BRANCH.test(pull.head);
}

function isReadyForReview(pull: GiteaImageUpdatePull): boolean {
  return pull.draft === false && !WIP_TITLE.test(pull.title);
}

function reviewStatus(pull: GiteaImageUpdatePull, checkStatus: ImageUpdatePullCheckStatus) {
  if (!isReadyForReview(pull)) return 'review';
  if (pull.mergeable !== true || checkStatus === 'failure') return 'blocked';
  return checkStatus === 'success' ? 'ready' : 'review';
}

export class WudImageUpdateReview {
  constructor(
    private readonly connections: Pick<GitRepositoryConnectionRepository, 'list' | 'findById'>,
    private readonly repositories: Pick<GitRepositoryService, 'withGitAccess'>,
    private readonly pulls: Pick<GiteaImageUpdatePulls, 'list' | 'get' | 'checks' | 'merge'>,
    private readonly audit: Pick<AuditService, 'record'>,
  ) {}

  async list(workspaceId: string, signal?: AbortSignal): Promise<ImageUpdatePullReviewList> {
    const result: ImageUpdatePullReviewList = { pulls: [], unreadableRepositories: 0 };
    const connections = (await this.connections.list(workspaceId)).filter(supportsReview);
    const deadline = AbortSignal.timeout(20_000);
    const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    for (const connection of connections) {
      try {
        requestSignal.throwIfAborted();
        const snapshot = await this.withForge(connection, requestSignal, async (forge) => {
          const rows: ImageUpdatePullReview[] = [];
          let unreadable = false;
          const pulls = (await this.pulls.list(forge)).filter((pull) =>
            isProposal(pull, connection.defaultBranch),
          );
          for (const pull of pulls) {
            const checkStatus = await this.pulls.checks({ ...forge, headSha: pull.headSha }).catch(() => {
              unreadable = true;
              return 'missing' as const;
            });
            const status = reviewStatus(pull, checkStatus);
            rows.push({
              repositoryId: connection.id,
              repositoryName: scrubString(connection.name, { secrets: [forge.token] }),
              number: pull.number,
              url: pull.url,
              headSha: pull.headSha,
              title: scrubString(pull.title, { secrets: [forge.token] }),
              checkStatus,
              status,
              ready: status === 'ready',
            });
          }
          return { rows, unreadable };
        });
        result.pulls.push(...snapshot.rows);
        if (snapshot.unreadable) result.unreadableRepositories += 1;
      } catch {
        result.unreadableRepositories += 1;
      }
    }
    return result;
  }

  async merge(
    workspaceId: string,
    actorUserId: string,
    input: { repositoryId: string; number: number; headSha: string },
    signal?: AbortSignal,
  ): Promise<{ merged: true }> {
    const { repositoryId, number, headSha } = input;
    const connection = await this.connections.findById(workspaceId, repositoryId);
    if (!connection) throw new NotFoundError('Repository not found.');
    if (!supportsReview(connection))
      throw new ConflictError('This repository has no Gitea write credential.');
    await this.withForge(connection, signal, async (forge) => {
      const pull = await this.pulls.get({ ...forge, number });
      if (
        !pull ||
        pull.number !== number ||
        pull.headSha !== headSha ||
        !isProposal(pull, connection.defaultBranch)
      ) {
        throw new ConflictError(
          'The Gitea pull request changed. Refresh the pull requests and review it again.',
        );
      }
      if (!isReadyForReview(pull)) {
        throw new ConflictError('Mark the pull request ready for review in Gitea before merging it.');
      }
      if (pull.mergeable !== true)
        throw new ConflictError('Gitea does not report this pull request as mergeable.');
      const checks = await this.pulls.checks({ ...forge, headSha });
      if (checks !== 'success') throw new ConflictError(CHECK_ERRORS[checks]);
      await this.pulls.merge({ ...forge, number, headSha });
    });
    await this.audit.record({
      action: 'wud.pull_request_merged',
      workspaceId,
      actorUserId,
      entityType: 'repository',
      entityId: repositoryId,
      meta: { pullNumber: number },
    });
    return { merged: true };
  }

  private withForge<T>(
    connection: GitRepositoryConnection,
    signal: AbortSignal | undefined,
    run: (input: GiteaImageUpdatePullInput) => Promise<T>,
  ): Promise<T> {
    return this.repositories.withGitAccess(connection.workspaceId, connection.id, async (provider, input) => {
      if (
        !input.auth ||
        provider.descriptor.type !== 'gitea' ||
        input.remoteUrl !== connection.remoteUrl ||
        input.branch !== connection.defaultBranch
      ) {
        throw new ConflictError('The Gitea repository connection changed. Refresh the pull requests.');
      }
      return run({ remoteUrl: input.remoteUrl, token: input.auth.token, signal });
    });
  }
}
