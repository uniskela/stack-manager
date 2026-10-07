import { structuredPatch } from 'diff';
import { z } from 'zod';
import { AppError, ConflictError, NotFoundError, ValidationError } from '@/server/domain/errors';
import { repoPathField } from '@/server/domain/stack';
import {
  GitOperationError,
  type GitCommitMetadata,
  type HistoryReader,
  type HistoryFileChange,
  type SourceTreeReader,
} from '@/server/providers/git/types';
import type { HistoryCommit, HistoryDetail, HistoryFileDetail, HistoryPage } from '@/shared/git-history';
import { isSecretPath, normalizeRepoPath } from '@/shared/source/paths';
import type { GitRepositoryService } from './git-repository-service';

const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const MAX_OFFSET = 10_000;
const MAX_FILES = 100;
const MAX_BLOB_BYTES = 256 * 1024;
const MAX_DETAIL_BYTES = 1024 * 1024;
const pageSchema = z.strictObject({
  limit: z.number().int().min(1).max(50).optional(),
  cursor: z.string().min(1).max(2048).optional(),
});
const cursorSchema = z.strictObject({
  v: z.literal(1),
  repositoryId: z.string(),
  rootPath: z.string(),
  headSha: z.string().regex(OBJECT_ID),
  offset: z.number().int().min(0).max(MAX_OFFSET),
  limit: z.number().int().min(1).max(50),
});

/** Read-only history at the fetched source snapshot. Repository and stack routes share this scope. */
export class GitHistoryService {
  constructor(
    private readonly repositories: GitRepositoryService,
    private readonly history: HistoryReader,
    private readonly source: SourceTreeReader,
  ) {}

  async list(
    workspaceId: string,
    repositoryId: string,
    rawRoot: string,
    input: { limit?: number; cursor?: string } = {},
  ): Promise<HistoryPage> {
    const rootPath = repoPathField(rawRoot, 'rootPath', { allowRoot: true });
    const parsed = pageSchema.safeParse(input);
    if (!parsed.success) throw new ValidationError('Invalid history page.');
    const page = parsed.data;
    let cursor: z.infer<typeof cursorSchema> | undefined;
    if (page.cursor) {
      try {
        if (!/^[A-Za-z0-9_-]+$/.test(page.cursor)) throw new Error();
        cursor = cursorSchema.parse(JSON.parse(Buffer.from(page.cursor, 'base64url').toString('utf8')));
      } catch {
        throw new ValidationError('Invalid history cursor.');
      }
      if (
        cursor.repositoryId !== repositoryId ||
        cursor.rootPath !== rootPath ||
        (page.limit !== undefined && page.limit !== cursor.limit)
      )
        throw new ValidationError('History cursor belongs to a different scope or page size.');
    }
    const snap = await this.#snapshot(workspaceId, repositoryId);
    return this.#safe(async () => {
      const headSha = cursor?.headSha ?? snap.commitSha;
      if (cursor && !(await this.history.isAncestor(snap.cloneDir, headSha, snap.commitSha))) {
        throw new ConflictError('History changed. Start a new history page.', 'history_changed');
      }
      const offset = cursor?.offset ?? 0;
      const limit = cursor?.limit ?? page.limit ?? 20;
      const result = await this.history.listCommits(snap.cloneDir, headSha, rootPath, { limit, offset });
      const commits: HistoryCommit[] = [];
      // Sequential bounded reads avoid spawning hundreds of Git processes for a single request.
      for (const sha of result.shas) {
        const metadata = await this.history.readCommit(snap.cloneDir, sha);
        const files = await this.history.changedFiles(snap.cloneDir, sha, rootPath);
        commits.push(commitView(metadata, files));
      }
      const nextOffset = offset + result.shas.length;
      const historyLimitReached = result.hasMore && nextOffset > MAX_OFFSET;
      const nextCursor =
        result.hasMore && !historyLimitReached
          ? Buffer.from(
              JSON.stringify({ v: 1, repositoryId, rootPath, headSha, offset: nextOffset, limit }),
            ).toString('base64url')
          : null;
      return { repositoryId, rootPath, headSha, commits, nextCursor, historyLimitReached };
    });
  }

  async detail(
    workspaceId: string,
    repositoryId: string,
    rawRoot: string,
    sha: string,
  ): Promise<HistoryDetail> {
    const rootPath = repoPathField(rawRoot, 'rootPath', { allowRoot: true });
    if (!OBJECT_ID.test(sha)) throw new ValidationError('Use a full commit SHA.');
    const snap = await this.#snapshot(workspaceId, repositoryId);
    return this.#safe(async () => {
      if (!(await this.history.isAncestor(snap.cloneDir, sha, snap.commitSha))) {
        throw new NotFoundError('Commit not found in fetched history.');
      }
      const metadata = await this.history.readCommit(snap.cloneDir, sha);
      const changed = await this.history.changedFiles(snap.cloneDir, sha, rootPath);
      if (changed.length === 0) throw new NotFoundError('Commit does not touch this scope.');
      const files: HistoryFileDetail[] = [];
      let budget = MAX_DETAIL_BYTES;
      for (const file of changed.slice(0, MAX_FILES)) {
        let locked: HistoryFileDetail['locked'] = isSecretPath(file.path) ? 'secret' : null;
        try {
          if (normalizeRepoPath(file.path) !== file.path) locked = 'unsupported_path';
        } catch {
          locked = 'unsupported_path';
        }
        const objects = [file.before, file.after].filter((o) => o !== null);
        if (!locked && objects.some((o) => o.kind === 'symlink')) locked = 'symlink';
        if (!locked && objects.some((o) => o.kind === 'submodule')) locked = 'submodule';
        let hunks: HistoryFileDetail['hunks'] = null;
        if (!locked) {
          const sizes = await Promise.all(
            objects.map((o) => this.history.objectSize(snap.cloneDir, o.objectSha)),
          );
          const bytes = sizes.reduce((a, b) => a + b, 0);
          if (sizes.some((size) => size > MAX_BLOB_BYTES) || bytes > budget) locked = 'too_large';
          else {
            budget -= bytes;
            const before = file.before
              ? await this.source.readBlob(snap.cloneDir, file.before.objectSha)
              : '';
            const after = file.after ? await this.source.readBlob(snap.cloneDir, file.after.objectSha) : '';
            if (before.includes('\0') || after.includes('\0')) locked = 'binary';
            else {
              const patch = structuredPatch('before', 'after', before, after, '', '', {
                context: 3,
                timeout: 50,
                maxEditLength: 10_000,
              });
              if (!patch) locked = 'diff_limit';
              else hunks = patch.hunks;
            }
          }
        }
        files.push({ path: file.path, status: file.status, locked, hunks });
      }
      return {
        repositoryId,
        rootPath,
        headSha: snap.commitSha,
        commit: { ...commitView(metadata, changed), files, diffBaseSha: metadata.parents[0] ?? null },
      };
    });
  }

  async #snapshot(workspaceId: string, repositoryId: string) {
    const source = await this.repositories.localSource(workspaceId, repositoryId);
    if (!source) throw new ConflictError('Fetch the repository before reading history.', 'not_synced');
    return source;
  }

  async #safe<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      // Provider stderr can contain arbitrary repository data. Never forward it to HTTP or logs.
      if (error instanceof GitOperationError) {
        throw new AppError(502, 'git_history_failed', 'Git history could not be read.');
      }
      throw error;
    }
  }
}

function commitView(metadata: GitCommitMetadata, files: HistoryFileChange[]): HistoryCommit {
  return {
    sha: metadata.sha,
    shortSha: metadata.sha.slice(0, 7),
    parents: metadata.parents,
    subject: metadata.message.split('\n')[0] ?? '',
    message: metadata.message,
    author: metadata.author,
    authoredAt: metadata.authoredAt,
    committedAt: metadata.committedAt,
    files: files.slice(0, MAX_FILES).map(({ path, status }) => ({ path, status })),
    filesTruncated: files.length > MAX_FILES,
  };
}
