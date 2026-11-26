import { createHash } from 'node:crypto';
import { ConflictError } from '@/server/domain/errors';
import { gitAuthorIdentityOf } from '@/server/domain/user';
import type {
  GiteaImageUpdatePull,
  GiteaImageUpdatePulls,
} from '@/server/providers/git/gitea-image-update-pulls';
import { GitOperationError, type GitIdentity } from '@/server/providers/git/types';
import type { AuditService } from './audit-service';
import type { GitRepositoryService } from './git-repository-service';
import type { GitRepositoryConnectionRepository, UserRepository } from './ports';
import { wudRepositoryPlanHash, type WudRepositoryChange } from './wud-repository-plan';

const prefix = 'stack-manager/image-updates/';
const legacyPrefixes = ['auto-portainer-wud-updates-', 'chore/wud-updates-', 'wud-review/'];
const subject = 'chore: update container images';

interface Publication {
  workspaceId: string;
  repositoryId: string;
  commitSha: string;
  changes: readonly WudRepositoryChange[];
  review: boolean;
  reviewNotes: readonly string[];
  signal?: AbortSignal;
}

export class WudImageUpdatePublication {
  constructor(
    private readonly connections: GitRepositoryConnectionRepository,
    private readonly repositories: GitRepositoryService,
    private readonly users: UserRepository,
    private readonly pulls: Pick<GiteaImageUpdatePulls, 'list' | 'create'>,
    private readonly audit: AuditService,
  ) {}

  async available(workspaceId: string, repositoryId: string): Promise<boolean> {
    const connection = await this.connections.findById(workspaceId, repositoryId);
    return connection?.gitProviderType === 'gitea' && Boolean(connection.credentialId);
  }

  async publish(plan: Publication, actorUserId: string | null, automationAuthor?: GitIdentity) {
    const user = actorUserId ? await this.users.findById(actorUserId) : null;
    const author = user && !user.disabledAt && user.role === 'admin' ? gitAuthorIdentityOf(user) : null;
    const identity = actorUserId === null ? automationAuthor : author;
    if (!identity)
      throw new ConflictError('Set a Git author identity before creating an update pull request.');
    const { workspaceId, repositoryId, commitSha, changes, review, signal } = plan;
    const connection = await this.connections.findById(workspaceId, repositoryId);
    if (
      connection?.gitProviderType !== 'gitea' ||
      !connection.credentialId ||
      connection.headSha !== commitSha
    ) {
      throw new ConflictError(
        'Review the freshly fetched files and confirm that this Gitea repository has a write token.',
      );
    }
    const key = createHash('sha256').update(commitSha).update(wudRepositoryPlanHash(changes)).digest('hex');
    const proposalBranch = prefix + key.slice(0, 32);
    try {
      const result = await this.repositories.withGitAccess(
        workspaceId,
        repositoryId,
        async (provider, input) => {
          if (
            !input.auth ||
            provider.descriptor.type !== 'gitea' ||
            input.branch !== connection.defaultBranch
          ) {
            throw new ConflictError('Refresh the Gitea repository connection and review the update again.');
          }
          const forge = { remoteUrl: input.remoteUrl, token: input.auth.token, signal };
          const trackedPulls = (await this.pulls.list(forge)).filter(({ base }) => base === input.branch);
          const owned = (pull: GiteaImageUpdatePull) =>
            pull.sameRepository === true && pull.head === proposalBranch;
          const existing = trackedPulls.find(owned);
          if (
            !existing &&
            trackedPulls.some(
              ({ head }) =>
                head.startsWith(prefix) || legacyPrefixes.some((legacy) => head.startsWith(legacy)),
            )
          ) {
            throw new ConflictError(
              'This repository already has an open image update pull request. Review it before creating another.',
              'image_update_pull_open',
            );
          }
          const commit = await provider.pushProposal({
            ...input,
            signal,
            proposalBranch,
            expectedHeadSha: commitSha,
            changes: changes.map(({ path, baseBlobSha, content }) => ({ path, baseBlobSha, content })),
            author: identity,
            message: subject + '\n\nStack-Manager-Image-Update: ' + key,
          });
          if (existing?.headSha === commit.sha) return { pull: existing, created: false };
          if (existing)
            throw new ConflictError('The existing update pull request changed. Review it in Gitea.');
          const title = review ? 'WIP: ' + subject : subject;
          const body = [
            'Stack Manager prepared a single commit for the reviewed image changes and their linked files.',
            review
              ? 'Review the compatibility or release evidence before marking this pull request ready.'
              : '',
            ...plan.reviewNotes,
            '',
            ...changes.map(({ path }) => '- ' + path.replace(/[\x60<>]/g, '')),
          ]
            .filter(Boolean)
            .join('\n');
          try {
            const pull = await this.pulls.create({
              ...forge,
              base: input.branch,
              head: proposalBranch,
              title,
              body,
            });
            if (pull.headSha !== commit.sha)
              throw new ConflictError('The proposal branch changed. Review the pull request in Gitea.');
            return { pull, created: true };
          } catch (error) {
            const recovered = (await this.pulls.list(forge).catch(() => [])).find(
              (pull) => owned(pull) && pull.base === input.branch && pull.headSha === commit.sha,
            );
            if (recovered) return { pull: recovered, created: false };
            throw error;
          }
        },
      );
      if (result.created) {
        await this.audit.record({
          action: 'wud.pull_request_created',
          workspaceId,
          actorUserId,
          entityType: 'repository',
          entityId: repositoryId,
          meta: { pullNumber: result.pull.number, fileCount: changes.length },
        });
      }
      return { number: result.pull.number, url: result.pull.url, headSha: result.pull.headSha, repositoryId };
    } catch (error) {
      if (error instanceof GitOperationError) throw new ConflictError(error.message);
      throw error;
    }
  }
}
