import type { AuditAction } from '@/server/domain/audit';
import { ConflictError, ForbiddenError, ValidationError } from '@/server/domain/errors';
import { gitAuthorIdentityOf } from '@/server/domain/user';
import {
  GitOperationError,
  type GitBranchInput,
  type GitProvider,
  type SourceTreeReader,
} from '@/server/providers/git/types';
import type { GitCommitRequest, GitPushRequest, GitWorkflowResult } from '@/shared/git-workflow';
import { isSecretPath, isWithin, normalizeRepoPath } from '@/shared/source/paths';
import { problemsFor } from '@/shared/source/problems';
import type { AuditService } from './audit-service';
import type { GitRepositoryService } from './git-repository-service';
import type { SourceDraftRepository, StackRepository, UserRepository } from './ports';

/** Draft orchestration only. Providers own Git locking, isolation and fast-forward protection. */
export class GitWorkflowService {
  constructor(
    private readonly repositories: GitRepositoryService,
    private readonly drafts: SourceDraftRepository,
    private readonly stacks: StackRepository,
    private readonly users: UserRepository,
    private readonly reader: SourceTreeReader,
    private readonly audit: AuditService,
  ) {}

  inspect(workspaceId: string, repositoryId: string, actorUserId: string): Promise<GitWorkflowResult> {
    return this.#run(workspaceId, repositoryId, actorUserId, async (provider, input, result) => {
      result.state = await provider.inspectBranch(input);
      if (result.state.behind > 0) result.status = 'remote_changed';
    });
  }

  async commit(
    workspaceId: string,
    repositoryId: string,
    request: GitCommitRequest,
    actorUserId: string,
  ): Promise<GitWorkflowResult> {
    validateCommitRequest(request);
    return this.#run(workspaceId, repositoryId, actorUserId, async (provider, input, result) => {
      const available = new Map((await this.drafts.list(repositoryId)).map((draft) => [draft.path, draft]));
      const selected = request.paths.map((file) => {
        const draft = available.get(file);
        if (!draft || draft.workspaceId !== workspaceId)
          throw new ValidationError('Select existing drafts from this repository.', {
            paths: 'Invalid selection.',
          });
        return draft;
      });

      result.state = await provider.inspectBranch(input);
      result.expectedRemoteSha = result.state.remoteHeadSha;
      const entries = new Map(
        (await this.reader.listTree(input.cloneDir, result.state.localHeadSha)).map((entry) => [
          entry.path,
          entry,
        ]),
      );
      result.outdatedPaths = selected
        .filter((draft) => (entries.get(draft.path)?.objectSha ?? null) !== draft.baseBlobSha)
        .map((draft) => draft.path);
      if (result.outdatedPaths.length) {
        result.status = 'draft_outdated';
        return;
      }
      if (result.state.behind > 0) {
        result.status = 'remote_changed';
        return;
      }

      const stacks = await this.stacks.listByRepository(workspaceId, repositoryId);
      const composePaths = new Set(stacks.map((stack) => stack.composePath));
      result.problems = selected.flatMap((draft) =>
        problemsFor(draft.path, draft.content, composePaths.has(draft.path) ? draft.path : undefined).map(
          (problem) => ({
            path: draft.path,
            line: problem.line,
            column: problem.column,
            severity: problem.severity,
            // Parser messages may quote source text or user-defined keys, including secrets.
            code:
              problem.code ??
              (problem.severity === 'error'
                ? 'source_error'
                : problem.severity === 'warning'
                  ? 'source_warning'
                  : 'source_info'),
          }),
        ),
      );
      if (result.problems.some((problem) => problem.severity === 'error')) {
        result.status = 'validation_blocked';
        return;
      }
      const warningCount = result.problems.filter((problem) => problem.severity === 'warning').length;
      if (warningCount && !request.acknowledgeWarnings) {
        result.status = 'warnings_unacknowledged';
        return;
      }
      const actor = await this.users.findById(actorUserId);
      const author = actor ? gitAuthorIdentityOf(actor) : null;
      if (!author) {
        result.status = 'git_identity_missing';
        return;
      }

      result.operation = 'commit';
      const committed = await provider.commit({
        ...input,
        expectedHeadSha: result.state.localHeadSha,
        changes: selected.map(({ path, content, baseBlobSha }) => ({ path, content, baseBlobSha })),
        message: request.message,
        author,
      });
      result.commitSha = committed.sha;
      result.status = 'commit_succeeded';
      const meta = {
        changedFileCount: selected.length,
        stackIds: stacks
          .filter((stack) => selected.some((draft) => isWithin(stack.rootPath, draft.path)))
          .map((stack) => stack.id),
      };
      await this.#audit('git.commit', workspaceId, actorUserId, result, meta);
      if (warningCount)
        await this.#audit('git.commit_validation_overridden', workspaceId, actorUserId, result, {
          warningCount,
        });
      // ponytail: keep every draft, including committed ones; add atomic snapshot reconciliation when automatic cleanup is needed.
      if (request.push)
        await this.#push(
          provider,
          input,
          { commitSha: committed.sha, expectedRemoteSha: result.state.remoteHeadSha },
          result,
          workspaceId,
          actorUserId,
        );
    });
  }

  push(
    workspaceId: string,
    repositoryId: string,
    request: GitPushRequest,
    actorUserId: string,
  ): Promise<GitWorkflowResult> {
    if (!OBJECT_ID.test(request.commitSha) || !OBJECT_ID.test(request.expectedRemoteSha))
      throw new ValidationError('Invalid request.', {
        commitSha: 'Commit and remote object ids are required.',
      });
    return this.#run(
      workspaceId,
      repositoryId,
      actorUserId,
      async (provider, input, result) => {
        await this.#push(provider, input, request, result, workspaceId, actorUserId);
      },
      request,
    );
  }

  async #push(
    provider: GitProvider,
    input: GitBranchInput,
    request: GitPushRequest,
    result: GitWorkflowResult,
    workspaceId: string,
    actorUserId: string,
  ) {
    result.operation = 'push';
    result.expectedRemoteSha = request.expectedRemoteSha;
    // Provider re-fetches, checks the expected remote SHA and ancestry, and sends an ordinary push.
    await provider.push({ ...input, ...request });
    result.status = 'push_succeeded';
    await this.#audit('git.push', workspaceId, actorUserId, result);
  }

  async #run(
    workspaceId: string,
    repositoryId: string,
    actorUserId: string,
    run: (provider: GitProvider, input: GitBranchInput, result: GitWorkflowResult) => Promise<void>,
    pushRequest?: GitPushRequest,
  ): Promise<GitWorkflowResult> {
    const user = await this.users.findById(actorUserId);
    // The current product has one admin role, with access to all workspaces; repository lookup is scoped.
    if (!user || user.disabledAt || user.role !== 'admin') throw new ForbiddenError();
    const source = await this.repositories.localSource(workspaceId, repositoryId);
    if (!source) throw new ConflictError('Fetch the repository before using the Git workflow.', 'not_synced');
    const result: GitWorkflowResult = {
      status: 'ready',
      repositoryId,
      branch: source.connection.defaultBranch,
      operation: pushRequest ? 'push' : 'inspect',
      commitSha: pushRequest?.commitSha ?? null,
      expectedRemoteSha: pushRequest?.expectedRemoteSha ?? null,
      state: null,
      problems: [],
      outdatedPaths: [],
      draftsPreserved: true,
    };
    try {
      await this.repositories.withGitAccess(workspaceId, repositoryId, async (provider, input) => {
        result.branch = input.branch;
        try {
          await run(provider, input, result);
        } catch (error) {
          if (error instanceof ValidationError) throw error;
          // Best-effort context after a race/rejection; failure must not hide a successful commit.
          if (error instanceof GitOperationError && ['conflict', 'rejected'].includes(error.kind))
            result.state = await provider.inspectBranch(input).catch(() => result.state);
          throw error;
        }
      });
    } catch (error) {
      if (error instanceof ValidationError) throw error;
      const reason = error instanceof GitOperationError ? error.kind : 'unknown';
      result.reason = reason;
      result.status =
        reason === 'busy'
          ? 'repository_busy'
          : reason === 'rejected'
            ? 'push_rejected'
            : reason === 'conflict'
              ? result.state &&
                (result.state.behind > 0 ||
                  (result.expectedRemoteSha !== null &&
                    result.state.remoteHeadSha !== result.expectedRemoteSha))
                ? 'remote_changed'
                : 'branch_changed'
              : 'git_operation_failed';
      // No raw exception messages, URLs, source content or credential material cross this boundary.
      if (result.operation === 'push')
        await this.#audit('git.push_rejected', workspaceId, actorUserId, result, {
          reason: result.status,
          gitReason: reason,
        });
      else if (result.operation === 'commit')
        await this.#audit('git.commit', workspaceId, actorUserId, result, { reason });
    }
    return result;
  }

  #audit(
    action: AuditAction,
    workspaceId: string,
    actorUserId: string,
    result: GitWorkflowResult,
    meta: Record<string, unknown> = {},
  ) {
    return this.audit.record({
      action,
      workspaceId,
      actorUserId,
      entityType: 'repository',
      entityId: result.repositoryId,
      outcome: ['commit_succeeded', 'push_succeeded'].includes(result.status) ? 'success' : 'failure',
      meta: {
        repositoryId: result.repositoryId,
        commitSha: result.commitSha,
        branch: result.branch,
        ...meta,
      },
    });
  }
}

const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
function validateCommitRequest(request: GitCommitRequest) {
  if (
    !Array.isArray(request.paths) ||
    !request.paths.length ||
    request.paths.length > 100 ||
    new Set(request.paths).size !== request.paths.length ||
    typeof request.message !== 'string' ||
    !request.message.trim() ||
    request.message.includes('\0') ||
    Buffer.byteLength(request.message) > 32 * 1024 ||
    (request.push !== undefined && typeof request.push !== 'boolean') ||
    (request.acknowledgeWarnings !== undefined && typeof request.acknowledgeWarnings !== 'boolean')
  )
    throw new ValidationError('Invalid commit request.');
  for (const file of request.paths) {
    try {
      if (normalizeRepoPath(file) !== file || isSecretPath(file)) throw new Error();
    } catch {
      throw new ValidationError('Select canonical, non-secret repository paths.', {
        paths: 'Invalid selection.',
      });
    }
  }
}
