import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { editComposeImages } from '@/shared/compose-image-edits';
import {
  MAX_IMAGE_UPDATE_CANDIDATES,
  type ImageUpdateIntent,
  type ImageUpdatePreview,
  type ImageUpdateReviewRow,
  type ImageUpdateStageResult,
} from '@/shared/image-update-planning';
import {
  imageReference,
  inspectStackImages,
  isImageTag,
  type StackImageUpdate,
} from '@/shared/image-updates';
import type { FileView } from '@/shared/source/types';
import type { Clock } from '@/server/domain/clock';
import { ConflictError, isAppError, ValidationError } from '@/server/domain/errors';
import type { Stack } from '@/server/domain/stack';
import { ChangelogReader } from '@/server/providers/changelog/reader';
import {
  IMAGE_UPDATE_POLICY_PATH,
  parseImageUpdatePolicy,
  policyExcludes,
  resolvePolicyChangelog,
  type ImageUpdatePolicy,
} from './image-update-policy';
import type { ImageUpdateService } from './image-update-service';
import type { StackRepository } from './ports';
import type { SourceService } from './source-service';
import {
  readWudChangelogCatalog,
  WUD_CHANGELOG_CATALOG_PATH,
  wudChangelogLink,
} from './wud-changelog-catalog';

type PreviewFile = ImageUpdatePreview['files'][number];
type StageFile = ImageUpdateStageResult['files'][number];
type StageEdit = Pick<ImageUpdateIntent, 'service' | 'source' | 'targetTag'> & { scanTimeUnavailable?: true };
type SelectedImage = NonNullable<ReturnType<typeof inspectStackImages>>[number];
const LEGACY_GROUPS_PATH = 'docs/wud-update-groups.json';
const PREVIEW_TTL_MS = 20 * 60_000;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

interface FileApproval {
  workspaceId: string;
  actorUserId: string;
  stackId: string;
  path: string;
  commitSha: string;
  blobSha: string;
  nextContentHash: string;
  edits: StageEdit[];
  review: boolean;
  expiresAt: number;
}

export class ImageUpdateStagingService {
  constructor(
    private readonly stacks: StackRepository,
    private readonly source: Pick<SourceService, 'readFile' | 'createDraftAtHead'>,
    private readonly wud: Pick<ImageUpdateService, 'stack'>,
    private readonly changelog: Pick<ChangelogReader, 'check'>,
    private readonly clock: Clock,
    private readonly secret: Buffer,
  ) {}

  async preview(
    workspaceId: string,
    actorUserId: string,
    candidates: ImageUpdateIntent[],
  ): Promise<ImageUpdatePreview> {
    if (!candidates.length || candidates.length > MAX_IMAGE_UPDATE_CANDIDATES)
      throw new ValidationError(`Select between 1 and ${MAX_IMAGE_UPDATE_CANDIDATES} image updates.`);
    const byStack = new Map<string, ImageUpdateIntent[]>();
    for (const item of candidates) {
      const list = byStack.get(item.stackId) ?? [];
      if (!isImageTag(item.targetTag) || list.some((other) => other.service === item.service)) {
        throw new ValidationError('Provide one valid target tag per selected service.');
      }
      list.push(item);
      byStack.set(item.stackId, list);
    }

    const files: PreviewFile[] = [];
    const entries = [...byStack];
    for (let i = 0; i < entries.length; i += 4) {
      files.push(
        ...(await Promise.all(
          entries
            .slice(i, i + 4)
            .map(([stackId, items]) => this.#previewFile(workspaceId, actorUserId, stackId, items)),
        )),
      );
    }
    return { files };
  }

  async stage(
    workspaceId: string,
    actorUserId: string,
    requests: Array<{ token: string; acknowledgeReview: boolean }>,
  ): Promise<ImageUpdateStageResult> {
    if (!requests.length || requests.length > MAX_IMAGE_UPDATE_CANDIDATES)
      throw new ValidationError('Select the reviewed files to stage.');
    const approvals = requests.map(({ token, acknowledgeReview }) => {
      const approval = this.#verify(token, workspaceId, actorUserId);
      return { approval, acknowledgeReview };
    });
    const seen = new Set<string>();
    for (const { approval } of approvals) {
      if (seen.has(approval.stackId)) throw new ValidationError('Select each stack only once.');
      seen.add(approval.stackId);
    }

    const files: StageFile[] = [];
    for (const { approval, acknowledgeReview } of approvals) {
      const stack = await this.stacks.findById(workspaceId, approval.stackId);
      const summary = {
        stackId: approval.stackId,
        stackName: stack?.name ?? 'Stack removed',
        path: approval.path,
      };
      const status =
        !stack || stack.composePath !== approval.path
          ? 'source_changed'
          : approval.review && !acknowledgeReview
            ? 'review_required'
            : await this.#stageFile(stack, approval, actorUserId);
      files.push({ ...summary, status });
    }
    return { files };
  }

  async #previewFile(
    workspaceId: string,
    actorUserId: string,
    stackId: string,
    items: ImageUpdateIntent[],
  ): Promise<PreviewFile> {
    const stack = await this.stacks.findById(workspaceId, stackId);
    const summary = {
      stackId,
      stackName: stack?.name ?? 'Stack unavailable',
      path: stack?.composePath ?? '',
    };
    const blocked = (reason: string, changes: ImageUpdateReviewRow[] = []): PreviewFile => ({
      ...summary,
      status: 'blocked',
      reason,
      changes,
      token: null,
    });
    if (!stack) return blocked('This stack is unavailable in the workspace.');

    const file = await this.#read(stack, stack.rootPath, stack.composePath);
    if (!file?.content || !file.blobSha || file.locked)
      return blocked('The committed Compose file is unavailable.');
    if (file.draft) return blocked('This Compose file already has a draft.');
    const committed = file.content;
    const inventory = inspectStackImages(committed);
    if (!inventory) return blocked('The committed Compose file could not be parsed.');
    const [config, externalGroups] = await Promise.all([
      this.#read(stack, '', IMAGE_UPDATE_POLICY_PATH),
      this.#read(stack, '', LEGACY_GROUPS_PATH),
    ]);
    if (
      (config && config.commitSha !== file.commitSha) ||
      (externalGroups && externalGroups.commitSha !== file.commitSha)
    ) {
      return blocked('The repository changed while loading its image update policy.');
    }
    if (config && (config.locked || config.content === null) && config.blobSha)
      return blocked('The committed image update policy is unreadable.');
    const catalog = externalGroups?.blobSha ? await this.#read(stack, '', WUD_CHANGELOG_CATALOG_PATH) : null;
    if (catalog && catalog.commitSha !== file.commitSha)
      return blocked('The repository changed while loading its changelog catalog.');
    const legacyChangelogs = readWudChangelogCatalog(catalog?.content ?? null);

    let policy: ImageUpdatePolicy;
    try {
      policy = parseImageUpdatePolicy(config?.content ?? null);
    } catch (error) {
      if (!isAppError(error)) throw error;
      return blocked(error.message);
    }
    const wud =
      items.some((item) => item.source === 'wud') && policy.sources.wud
        ? await this.wud.stack(workspaceId, stackId)
        : null;
    const byService = new Map(inventory.map((entry) => [entry.name, entry]));
    const suggestions = new Map(
      wud?.images.filter((image) => image.status === 'available').map((image) => [image.name, image]),
    );

    const rows: ImageUpdateReviewRow[] = [];
    for (let i = 0; i < items.length; i += 3) {
      rows.push(
        ...(await Promise.all(
          items.slice(i, i + 3).map((intent) => {
            const match = intent.source === 'wud' ? suggestions.get(intent.service) : undefined;
            return this.#review(
              stack.composePath,
              committed,
              intent,
              byService.get(intent.service),
              match?.candidateTag === intent.targetTag ? match : undefined,
              policy,
              legacyChangelogs,
            );
          }),
        )),
      );
    }
    // The existing workflow owns this repository's linked and documentation edits.
    if (externalGroups?.blobSha)
      return blocked(
        'This repository uses an external WUD update policy. Stage the changes through that workflow.',
        rows,
      );
    const stageable = new Set(rows.filter((row) => row.status !== 'blocked').map((row) => row.service));
    if (!stageable.size) return blocked('None of the selected updates can be staged.', rows);

    const edits: StageEdit[] = items
      .filter((item) => stageable.has(item.service))
      .map(({ service, source, targetTag }) => ({
        service,
        source,
        targetTag,
        ...(source === 'wud' && suggestions.get(service)?.scanTimeUnavailable
          ? { scanTimeUnavailable: true as const }
          : {}),
      }));
    const { content } = editComposeImages(committed, edits);
    const review = rows.some((row) => row.status === 'review');
    const token = this.#sign({
      workspaceId,
      actorUserId,
      stackId,
      path: stack.composePath,
      commitSha: file.commitSha,
      blobSha: file.blobSha,
      nextContentHash: hash(content),
      edits,
      review,
      expiresAt: this.clock.now().getTime() + PREVIEW_TTL_MS,
    });
    return { ...summary, status: review ? 'review' : 'ready', reason: null, changes: rows, token };
  }

  async #review(
    path: string,
    committed: string,
    intent: ImageUpdateIntent,
    image: SelectedImage | undefined,
    wud: StackImageUpdate | undefined,
    policy: ImageUpdatePolicy,
    legacyChangelogs: ReturnType<typeof readWudChangelogCatalog>,
  ): Promise<ImageUpdateReviewRow> {
    const summary = { service: intent.service, source: intent.source, before: image?.image ?? null };
    const blocked = (note: string): ImageUpdateReviewRow => ({
      ...summary,
      after: null,
      status: 'blocked',
      notes: [note],
      changelogUrl: null,
    });
    const ref = image?.image ? imageReference(image.image) : null;
    if (!image?.editable || !ref?.tag || ref.digest) return blocked('Select a direct Compose image tag.');
    if (!policy.sources[intent.source])
      return blocked('This update source is disabled by repository policy.');
    if (
      (image.excluded && (intent.source === 'wud' || policy.respectWudOptOut)) ||
      policyExcludes(policy, path, intent.service)
    ) {
      return blocked('The service is excluded by its Compose labels or repository policy.');
    }
    if (intent.source === 'wud' && !wud)
      return blocked('WUD no longer reports this candidate for the stack.');

    let after: string;
    try {
      after = editComposeImages(committed, [intent]).changes[0]!.after;
    } catch {
      return blocked('The image value cannot be safely edited.');
    }
    const input = {
      path,
      service: intent.service,
      image: ref.name,
      repository: ref.repository,
      currentTag: ref.tag,
      targetTag: intent.targetTag,
      override: intent.changelogUrl,
    };
    const url =
      resolvePolicyChangelog(policy, input) ?? wudChangelogLink(legacyChangelogs, input) ?? wud?.changelogUrl;
    const evidence = url ? await this.changelog.check(url, ref.tag, intent.targetTag) : null;
    const notes = evidence ? [...evidence.signals] : [];
    const missing = evidence?.status !== 'checked';
    if (missing) notes.unshift(evidence?.detail || 'No changelog link was supplied.');
    const major = isMajorChange(ref.tag, intent.targetTag);
    if (major) notes.push('The image major version changes.');
    const risk = major || (evidence?.signals.length ?? 0) > 0;
    if (wud?.scanTimeUnavailable) notes.push('WUD reports this candidate without its last scan time.');
    const status =
      (missing && policy.missingEvidence === 'block') || (risk && policy.riskSignals === 'block')
        ? 'blocked'
        : notes.length
          ? 'review'
          : 'ready';
    return { ...summary, after, status, notes, changelogUrl: evidence?.url || null };
  }

  async #stageFile(stack: Stack, approval: FileApproval, actorUserId: string): Promise<StageFile['status']> {
    const file = await this.#read(stack, stack.rootPath, approval.path);
    if (!file?.content || file.commitSha !== approval.commitSha || file.blobSha !== approval.blobSha)
      return 'source_changed';
    if (file.draft) return 'draft_exists';
    const wudEdits = approval.edits.filter((edit) => edit.source === 'wud');
    if (wudEdits.length) {
      const view = await this.wud.stack(stack.workspaceId, stack.id);
      if (
        wudEdits.some(
          (edit) =>
            !view.images.some(
              (image) =>
                image.name === edit.service &&
                image.status === 'available' &&
                image.candidateTag === edit.targetTag &&
                (!image.scanTimeUnavailable || edit.scanTimeUnavailable === true),
            ),
        )
      )
        return 'candidate_changed';
    }
    const { content } = editComposeImages(file.content, approval.edits);
    if (hash(content) !== approval.nextContentHash) return 'source_changed';
    try {
      return await this.source.createDraftAtHead(
        stack.workspaceId,
        stack.repositoryId,
        stack.rootPath,
        {
          stackId: stack.id,
          path: approval.path,
          commitSha: approval.commitSha,
          blobSha: approval.blobSha,
          content,
        },
        actorUserId,
      );
    } catch (error) {
      if (isAppError(error) && (error.status === 404 || error.status === 409)) return 'source_changed';
      throw error;
    }
  }

  async #read(stack: Stack, root: string, path: string): Promise<FileView | null> {
    try {
      return await this.source.readFile(stack.workspaceId, stack.repositoryId, root, path);
    } catch (error) {
      if (isAppError(error) && (error.status === 404 || error.status === 409)) return null;
      throw error;
    }
  }

  #mac(body: string): string {
    return createHmac('sha256', this.secret)
      .update('stack-manager:image-preview:v1\0')
      .update(body)
      .digest('base64url');
  }

  #sign(input: FileApproval): string {
    const body = Buffer.from(JSON.stringify(input)).toString('base64url');
    return body + '.' + this.#mac(body);
  }

  #verify(token: string, workspaceId: string, actorUserId: string): FileApproval {
    const [body, mac, extra] = token.split('.');
    const invalid = () => new ConflictError('This preview could not be verified. Preview the update again.');
    if (!body || !mac || extra !== undefined || !/^[a-zA-Z0-9_-]{43}$/.test(mac)) throw invalid();
    if (!timingSafeEqual(Buffer.from(mac), Buffer.from(this.#mac(body)))) throw invalid();
    const approval = JSON.parse(Buffer.from(body, 'base64url').toString()) as FileApproval;
    if (
      approval.workspaceId !== workspaceId ||
      approval.actorUserId !== actorUserId ||
      approval.expiresAt <= this.clock.now().getTime()
    )
      throw invalid();
    return approval;
  }
}

function isMajorChange(currentTag: string, targetTag: string): boolean {
  const major = (tag: string) => /^v?(\d+)\.\d+(?:[.-]|$)/i.exec(tag)?.[1];
  return !!major(currentTag) && !!major(targetTag) && major(currentTag) !== major(targetTag);
}
