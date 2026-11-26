import { createHash } from 'node:crypto';
import type { ImageUpdatePredecessor } from '@/shared/image-update-planning';
import { AppError, ConflictError } from '@/server/domain/errors';
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
  supersede?: ImageUpdatePredecessor;
}

export class WudImageUpdatePublication {
  private readonly publishing = new Set<string>();

  constructor(
    private readonly connections: GitRepositoryConnectionRepository,
    private readonly repositories: GitRepositoryService,
    private readonly users: UserRepository,
    private readonly pulls: Pick<GiteaImageUpdatePulls, 'list' | 'create' | 'get' | 'close'>,
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
    if (this.publishing.has(repositoryId))
      throw new ConflictError(
        'Another update PR is being published for this repository. Retry when it finishes.',
      );
    this.publishing.add(repositoryId);
    try {
      const pull = await this.repositories.withGitAccess(
        workspaceId,
        repositoryId,
        async (provider, input) => {
          if (
            !input.auth ||
            provider.descriptor.type !== 'gitea' ||
            input.remoteUrl !== connection.remoteUrl ||
            input.branch !== connection.defaultBranch
          ) {
            throw new ConflictError('Refresh the Gitea repository connection and review the update again.');
          }
          const forge = { remoteUrl: input.remoteUrl, token: input.auth.token, signal };
          const trackedPulls = (await this.pulls.list(forge)).filter(({ base }) => base === input.branch);
          const owned = (pull: GiteaImageUpdatePull) =>
            pull.sameRepository === true && pull.head === proposalBranch;
          const existing = trackedPulls.find(owned);
          const others = trackedPulls.filter(
            (pull) =>
              !owned(pull) &&
              (pull.head.startsWith(prefix) || legacyPrefixes.some((legacy) => pull.head.startsWith(legacy))),
          );
          const previous = others[0];
          if (previous && (!existing || actorUserId !== null)) {
            const eligible =
              others.length === 1 &&
              previous.sameRepository === true &&
              actorUserId !== null &&
              (/^stack-manager\/image-updates\/[a-f0-9]{32}$/.test(previous.head) ||
                legacyPrefixes.some((legacy) => previous.head.startsWith(legacy)));
            if (
              !eligible ||
              plan.supersede?.number !== previous.number ||
              plan.supersede.headSha !== previous.headSha
            ) {
              throw new AppError(
                409,
                'image_update_pull_open',
                `Review open image update PR #${previous.number} before creating another.`,
                eligible
                  ? { number: String(previous.number), headSha: previous.headSha, url: previous.url }
                  : undefined,
              );
            }
          } else if (plan.supersede && !existing) {
            throw new ConflictError('The pull request to replace changed. Review the update again.');
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
          if (existing && existing.headSha !== commit.sha)
            throw new ConflictError('The existing update pull request changed. Review it in Gitea.');
          const title = review ? 'WIP: ' + subject : subject;
          const body = [
            'Stack Manager prepared a single commit for the reviewed image changes and their linked files.',
            review
              ? 'Review the compatibility or release evidence before marking this pull request ready.'
              : '',
            ...(plan.supersede ? [`Supersedes #${plan.supersede.number}.`] : []),
            ...plan.reviewNotes,
            '',
            ...changes.map(({ path }) => '- ' + path.replace(/[\x60<>]/g, '')),
          ]
            .filter(Boolean)
            .join('\n');
          let pull = existing;
          if (!pull) {
            try {
              pull = await this.pulls.create({
                ...forge,
                base: input.branch,
                head: proposalBranch,
                title,
                body,
              });
              if (pull.headSha !== commit.sha)
                throw new ConflictError('The proposal branch changed. Review the pull request in Gitea.');
              await this.audit.record({
                action: 'wud.pull_request_created',
                workspaceId,
                actorUserId,
                entityType: 'repository',
                entityId: repositoryId,
                meta: { pullNumber: pull.number, fileCount: changes.length },
              });
            } catch (error) {
              const recovered = (await this.pulls.list(forge).catch(() => [])).find(
                (pull) => owned(pull) && pull.base === input.branch && pull.headSha === commit.sha,
              );
              if (!recovered) throw error;
              pull = recovered;
            }
          }
          if (plan.supersede && previous) {
            if (!owned(pull) || pull.base !== input.branch || pull.number === previous.number)
              throw new ConflictError('Review the replacement in Gitea before closing the previous PR.');
            const current = await this.pulls.get({ ...forge, number: previous.number });
            if (current) {
              if (
                current.sameRepository !== true ||
                current.base !== input.branch ||
                current.head !== previous.head ||
                current.headSha !== previous.headSha
              ) {
                throw new ConflictError(
                  `Replacement #${pull.number} is open. PR #${previous.number} changed and needs review in Gitea.`,
                );
              }
              try {
                await this.pulls.close({ ...forge, number: previous.number });
              } catch {
                throw new ConflictError(
                  `Replacement #${pull.number} is open. Check #${previous.number} in Gitea or retry superseding it.`,
                );
              }
              await this.audit.record({
                action: 'wud.pull_request_superseded',
                workspaceId,
                actorUserId,
                entityType: 'repository',
                entityId: repositoryId,
                meta: { pullNumber: previous.number, replacementNumber: pull.number },
              });
            }
          }
          return pull;
        },
      );
      return { number: pull.number, url: pull.url, headSha: pull.headSha, repositoryId };
    } catch (error) {
      if (error instanceof GitOperationError) throw new ConflictError(error.message);
      throw error;
    } finally {
      this.publishing.delete(repositoryId);
    }
  }
}
