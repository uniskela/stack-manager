import type { Clock } from '@/server/domain/clock';
import { MAX_EDITABLE_BYTES, type SourceDraft } from '@/server/domain/draft';
import { ConflictError, NotFoundError, ValidationError } from '@/server/domain/errors';
import { repoPathField } from '@/server/domain/stack';
import type { SourceTreeEntry, SourceTreeReader } from '@/server/providers/git/types';
import { isSecretPath, isWithin, languageFor } from '@/shared/source/paths';
import type { ChangeView, FileView, LockReason, TreeNodeView } from '@/shared/source/types';
import type { AuditService } from './audit-service';
import type { GitRepositoryService } from './git-repository-service';
import type { SourceDraftRepository, StackRepository } from './ports';

export type { ChangeView, DraftView, FileView, LockReason, TreeNodeView } from '@/shared/source/types';

interface Snapshot {
  repositoryId: string;
  cloneDir: string;
  commitSha: string;
  entries: SourceTreeEntry[];
  byPath: Map<string, SourceTreeEntry>;
}

const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const utf8Bytes = (s: string) => Buffer.byteLength(s, 'utf8');

/**
 * Read access to committed repository content plus draft edits (PR #3). Everything is scoped to a
 * directory (`root`, the stack root) so a stack page can only see and edit its own files.
 *
 * Secret-looking files (docs/SECURITY.md) are listed but their contents are never returned and drafts
 * for them are refused. Committed content comes from Git objects, never the working tree.
 */
export class SourceService {
  constructor(
    private readonly repositories: GitRepositoryService,
    private readonly reader: SourceTreeReader,
    private readonly drafts: SourceDraftRepository,
    private readonly stacks: StackRepository,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly newId: () => string,
  ) {}

  /** Files at or under `root`, including new files that exist only as drafts. */
  async tree(workspaceId: string, repositoryId: string, root: string) {
    const snap = await this.#snapshot(workspaceId, repositoryId);
    const drafts = new Map((await this.drafts.list(repositoryId, root || undefined)).map((d) => [d.path, d]));
    const nodes: TreeNodeView[] = [];
    for (const e of snap.entries) {
      if (!isWithin(root, e.path)) continue;
      nodes.push({
        path: e.path,
        kind: e.kind,
        size: e.size,
        locked: lockReason(e),
        draft: drafts.has(e.path) ? 'modified' : null,
      });
      drafts.delete(e.path);
    }
    for (const d of drafts.values()) {
      nodes.push({ path: d.path, kind: 'file', size: utf8Bytes(d.content), locked: null, draft: 'new' });
    }
    nodes.sort((a, b) => a.path.localeCompare(b.path));
    return { commitSha: snap.commitSha, entries: nodes };
  }

  async readFile(
    workspaceId: string,
    repositoryId: string,
    root: string,
    rawPath: string,
  ): Promise<FileView> {
    const path = this.#scopedPath(root, rawPath);
    const snap = await this.#snapshot(workspaceId, repositoryId);
    const draft = await this.drafts.find(repositoryId, path);
    const view = await this.#fileView(snap, path, draft);
    if (!view) throw new NotFoundError('File not found.');
    return view;
  }

  /** Reads committed content for server-side analysis; null if missing, locked or unreadable. */
  async readEffective(
    workspaceId: string,
    repositoryId: string,
    root: string,
    path: string,
  ): Promise<{ content: string; fromDraft: boolean } | null> {
    try {
      const view = await this.readFile(workspaceId, repositoryId, root, path);
      if (view.locked) return null;
      if (view.draft) return { content: view.draft.content, fromDraft: true };
      return view.content === null ? null : { content: view.content, fromDraft: false };
    } catch (error) {
      if (error instanceof NotFoundError) return null;
      throw error;
    }
  }

  async saveDraft(
    workspaceId: string,
    repositoryId: string,
    root: string,
    input: { path: string; content: string; baseBlobSha: string | null },
    actorUserId: string,
  ): Promise<FileView> {
    const path = this.#scopedPath(root, input.path);
    if (isSecretPath(path)) {
      throw new ValidationError('Secret files cannot be edited here.', {
        path: 'Files such as .env, keys and secrets/ are never stored by stack-manager. Commit a .env.example instead.',
      });
    }
    if (input.content.includes('\u0000')) {
      throw new ValidationError('Binary content is not supported.', {
        content: 'The text contains NUL bytes.',
      });
    }
    const bytes = utf8Bytes(input.content);
    if (bytes > MAX_EDITABLE_BYTES) {
      throw new ValidationError('File is too large.', { content: 'Editable files are limited to 1 MiB.' });
    }
    if (input.baseBlobSha !== null && !OBJECT_ID.test(input.baseBlobSha)) {
      throw new ValidationError('Invalid request.', { baseBlobSha: 'Not an object id.' });
    }

    const snap = await this.#snapshot(workspaceId, repositoryId);
    const entry = snap.byPath.get(path);
    if (entry && entry.kind !== 'file') {
      throw new ValidationError('This entry cannot be edited.', {
        path: `${entry.kind} entries are read-only.`,
      });
    }
    if (!entry) this.#assertCreatable(snap, path);
    const committed = entry ? await this.#readCommitted(snap, entry) : null;
    if (entry && committed === null) {
      throw new ValidationError('This file cannot be edited.', { path: 'Binary or larger than 1 MiB.' });
    }

    const existing = await this.drafts.find(repositoryId, path);
    // Saving the committed content back is "no change": drop the draft instead of storing a copy.
    if (committed !== null && committed === input.content) {
      if (existing) {
        await this.drafts.delete(repositoryId, path);
        await this.#auditDraft('draft.discard', workspaceId, repositoryId, path, actorUserId, {
          reverted: true,
        });
      }
      return (await this.#fileView(snap, path, null))!;
    }

    const now = this.clock.now();
    const draft = await this.drafts.upsert({
      id: existing?.id ?? this.newId(),
      workspaceId,
      repositoryId,
      path,
      content: input.content,
      // Keep the base the draft was started from; later saves only change the content.
      baseBlobSha: existing ? existing.baseBlobSha : (input.baseBlobSha ?? entry?.objectSha ?? null),
      baseCommitSha: existing?.baseCommitSha ?? snap.commitSha,
      createdByUserId: existing?.createdByUserId ?? actorUserId,
      updatedByUserId: actorUserId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    await this.#auditDraft('draft.save', workspaceId, repositoryId, path, actorUserId, {
      bytes,
      isNew: !entry,
    });
    return (await this.#fileView(snap, path, draft))!;
  }

  /** Removes a draft. Returns the committed file, or null when the draft was a new file. */
  async discardDraft(
    workspaceId: string,
    repositoryId: string,
    root: string,
    rawPath: string,
    actorUserId: string,
  ): Promise<FileView | null> {
    const path = this.#scopedPath(root, rawPath);
    const snap = await this.#snapshot(workspaceId, repositoryId);
    if (!(await this.drafts.delete(repositoryId, path))) throw new NotFoundError('No draft for this file.');
    await this.#auditDraft('draft.discard', workspaceId, repositoryId, path, actorUserId, {});
    return this.#fileView(snap, path, null);
  }

  /** Drafts under `root` with their base content, for review. */
  async changes(workspaceId: string, repositoryId: string, root: string): Promise<ChangeView[]> {
    const snap = await this.#snapshot(workspaceId, repositoryId);
    const drafts = await this.drafts.list(repositoryId, root || undefined);
    return Promise.all(
      drafts.map(async (d) => {
        const entry = snap.byPath.get(d.path);
        let before: string | null = null;
        if (d.baseBlobSha)
          before = await this.reader.readBlob(snap.cloneDir, d.baseBlobSha).catch(() => null);
        return {
          path: d.path,
          isNew: d.baseBlobSha === null,
          outdated: isOutdated(d, entry),
          updatedAt: d.updatedAt.toISOString(),
          before,
          after: d.content,
        };
      }),
    );
  }

  async countDrafts(repositoryId: string, root: string): Promise<number> {
    return (await this.drafts.list(repositoryId, root || undefined)).length;
  }

  /** Drafts outdated vs current tree blobs (no draft content). */
  async listOutdatedDraftSummaries(
    workspaceId: string,
  ): Promise<Array<{ repositoryId: string; path: string; stackId?: string }>> {
    const [repos, stacks] = await Promise.all([
      this.repositories.list(workspaceId),
      this.stacks.list(workspaceId),
    ]);
    const out: Array<{ repositoryId: string; path: string; stackId?: string }> = [];
    for (const repo of repos) {
      const source = await this.repositories.localSource(workspaceId, repo.id);
      if (!source) continue;
      const entries = await this.reader.listTree(source.cloneDir, source.commitSha);
      const byPath = new Map(entries.map((e) => [e.path, e]));
      const drafts = await this.drafts.list(repo.id);
      for (const draft of drafts) {
        if (!isOutdated(draft, byPath.get(draft.path))) continue;
        out.push({
          repositoryId: repo.id,
          path: draft.path,
          stackId: stackIdForPath(stacks, repo.id, draft.path),
        });
      }
    }
    out.sort((a, b) => a.path.localeCompare(b.path));
    return out;
  }

  async #fileView(snap: Snapshot, path: string, draft: SourceDraft | null): Promise<FileView | null> {
    const entry = snap.byPath.get(path) ?? null;
    if (!entry && !draft) return null;
    const locked = entry ? lockReason(entry) : isSecretPath(path) ? 'secret' : null;
    let content: string | null = null;
    let finalLock = locked;
    if (entry && !locked) {
      content = await this.#readCommitted(snap, entry);
      if (content === null) finalLock = 'binary';
    }
    return {
      path,
      language: languageFor(path),
      commitSha: snap.commitSha,
      blobSha: entry?.objectSha ?? null,
      size: entry?.size ?? (draft ? utf8Bytes(draft.content) : 0),
      content,
      editable: finalLock === null,
      locked: finalLock,
      draft:
        draft && finalLock === null
          ? {
              content: draft.content,
              baseBlobSha: draft.baseBlobSha,
              updatedAt: draft.updatedAt.toISOString(),
              outdated: isOutdated(draft, entry ?? undefined),
            }
          : null,
    };
  }

  /** Committed text, or null when the blob is binary. Callers check size limits via lockReason. */
  async #readCommitted(snap: Snapshot, entry: SourceTreeEntry): Promise<string | null> {
    if (entry.size > MAX_EDITABLE_BYTES) return null;
    const text = await this.reader.readBlob(snap.cloneDir, entry.objectSha);
    return text.includes('\u0000') ? null : text;
  }

  #assertCreatable(snap: Snapshot, path: string) {
    const prefix = `${path}/`;
    if (snap.entries.some((e) => e.path.startsWith(prefix))) {
      throw new ValidationError('A directory with that name exists.', { path: 'Choose a file name.' });
    }
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join('/');
      if (snap.byPath.has(parent)) {
        throw new ValidationError('Invalid path.', { path: `"${parent}" is a file, not a directory.` });
      }
    }
  }

  #scopedPath(root: string, raw: string): string {
    const path = repoPathField(raw, 'path');
    if (!isWithin(root, path)) {
      throw new ValidationError('Path is outside this stack.', {
        path: 'Choose a file inside the stack folder.',
      });
    }
    return path;
  }

  async #snapshot(workspaceId: string, repositoryId: string): Promise<Snapshot> {
    const source = await this.repositories.localSource(workspaceId, repositoryId);
    if (!source) {
      throw new ConflictError(
        'The repository has not been fetched yet. Fetch it and try again.',
        'not_synced',
      );
    }
    const entries = await this.reader.listTree(source.cloneDir, source.commitSha);
    return {
      repositoryId,
      cloneDir: source.cloneDir,
      commitSha: source.commitSha,
      entries,
      byPath: new Map(entries.map((e) => [e.path, e])),
    };
  }

  #auditDraft(
    action: 'draft.save' | 'draft.discard',
    workspaceId: string,
    repositoryId: string,
    path: string,
    actorUserId: string,
    meta: Record<string, unknown>,
  ) {
    // Paths only: draft content is never written to audit or logs.
    return this.audit.record({
      action,
      actorUserId,
      workspaceId,
      entityType: 'repository',
      entityId: repositoryId,
      meta: { path, ...meta },
    });
  }
}

function lockReason(entry: SourceTreeEntry): LockReason | null {
  if (entry.kind === 'symlink') return 'symlink';
  if (entry.kind === 'submodule') return 'submodule';
  if (isSecretPath(entry.path)) return 'secret';
  if (entry.size > MAX_EDITABLE_BYTES) return 'too_large';
  return null;
}

function isOutdated(draft: SourceDraft, entry: SourceTreeEntry | undefined): boolean {
  if (draft.baseBlobSha === null) return entry !== undefined;
  return entry?.objectSha !== draft.baseBlobSha;
}

function stackIdForPath(
  stacks: Awaited<ReturnType<StackRepository['list']>>,
  repositoryId: string,
  path: string,
): string | undefined {
  let best: (typeof stacks)[number] | undefined;
  for (const stack of stacks) {
    if (stack.repositoryId !== repositoryId || !isWithin(stack.rootPath, path)) continue;
    if (!best || stack.rootPath.length > best.rootPath.length) best = stack;
  }
  return best?.id;
}
