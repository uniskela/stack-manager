import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { editComposeImages } from '@/shared/compose-image-edits';
import {
  MAX_IMAGE_UPDATE_CANDIDATES,
  type ImageUpdateIntent,
  type ImageUpdatePublication,
  type ImageUpdatePreview,
  type ImageUpdateReviewRow,
  type ImageUpdateStageResult,
} from '@/shared/image-update-planning';
import { imageReference, inspectStackImages, type StackImageUpdate } from '@/shared/image-updates';
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
import type { WudImageUpdatePublication } from './wud-image-update-publication';
import { planWudRepositoryUpdate, wudRepositoryDiff, wudRepositoryPlanHash } from './wud-repository-plan';
import { parseWudUpdateGroups, WUD_UPDATE_GROUPS_PATH } from './wud-update-groups';
import {
  readWudChangelogCatalog,
  WUD_CHANGELOG_CATALOG_PATH,
  wudChangelogLink,
} from './wud-changelog-catalog';

type PreviewFile = ImageUpdatePreview['files'][number];
type StageFile = ImageUpdateStageResult['files'][number];
type StageEdit = Pick<ImageUpdateIntent, 'service' | 'source' | 'targetTag'> & { scanTimeUnavailable?: true };
type SelectedImage = NonNullable<ReturnType<typeof inspectStackImages>>[number];
type ChangelogCatalog = ReturnType<typeof readWudChangelogCatalog>;
type StageRequest = { token: string; acknowledgeReview: boolean };
type ProposedEdit = { after: string } | { reason: string };
const PORTAINER_WUD_SKILL_PATH = '.opencode/skills/portainer-wud-updates/SKILL.md';
const PREVIEW_TTL_MS = 20 * 60_000;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

interface FileApproval {
  workspaceId: string;
  actorUserId: string | null;
  stackId: string;
  path: string;
  commitSha: string;
  blobSha: string;
  nextContentHash: string;
  edits: StageEdit[];
  review: boolean;
  proposal?: true;
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
    private readonly publication: WudImageUpdatePublication,
  ) {}

  async usesRepositoryWorkflow(workspaceId: string, stackId: string): Promise<boolean> {
    const stack = await this.stacks.findById(workspaceId, stackId);
    if (!stack) return false;
    const policy = await this.#read(stack, '', WUD_UPDATE_GROUPS_PATH);
    return Boolean(policy?.blobSha) && !(await this.publication.available(workspaceId, stack.repositoryId));
  }

  async repositoryWorkflowGuide(workspaceId: string, stackId: string) {
    const stack = await this.stacks.findById(workspaceId, stackId);
    if (!stack) return null;
    const policy = await this.#read(stack, '', WUD_UPDATE_GROUPS_PATH);
    if (!policy?.blobSha) return null;
    const native = await this.publication.available(workspaceId, stack.repositoryId);
    const skill = await this.#read(stack, '', PORTAINER_WUD_SKILL_PATH);
    const skillPath =
      skill?.commitSha === policy.commitSha && !skill.locked && skill.content
        ? PORTAINER_WUD_SKILL_PATH
        : null;
    return { policyPath: WUD_UPDATE_GROUPS_PATH, skillPath, native };
  }

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
      list.push(item);
      byStack.set(item.stackId, list);
    }

    const files = await Promise.all(
      [...byStack].map(([stackId, items]) =>
        this.#previewFile(workspaceId, actorUserId, stackId, items).catch(() =>
          blockedFile({ stackId, stackName: 'Stack unavailable', path: '' }, 'Could not load this stack.'),
        ),
      ),
    );
    return { files };
  }

  async stage(
    workspaceId: string,
    actorUserId: string,
    requests: StageRequest[],
  ): Promise<ImageUpdateStageResult> {
    if (!requests.length || requests.length > MAX_IMAGE_UPDATE_CANDIDATES)
      throw new ValidationError('Select the reviewed files to stage.');
    const verified = requests.flatMap(({ token, acknowledgeReview }) => {
      try {
        return [{ approval: this.#verify(token, workspaceId, actorUserId), acknowledgeReview }];
      } catch (error) {
        if (isAppError(error) && error.status === 409) return [];
        throw error;
      }
    });
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const { approval } of verified) {
      if (seen.has(approval.stackId)) duplicates.add(approval.stackId);
      seen.add(approval.stackId);
    }
    const approvals = verified.filter(({ approval }) => !duplicates.has(approval.stackId));
    if (!approvals.length) {
      if (duplicates.size) throw new ValidationError('Select each stack only once.');
      throw invalidPreview();
    }
    const files = await Promise.all(
      approvals.map(({ approval, acknowledgeReview }) =>
        this.#stageApproval(workspaceId, actorUserId, approval, acknowledgeReview),
      ),
    );
    return { files, rejectedPreviews: requests.length - files.length };
  }

  async publish(
    workspaceId: string,
    actorUserId: string,
    { token, acknowledgeReview }: StageRequest,
  ): Promise<ImageUpdatePublication> {
    const approval = this.#verify(token, workspaceId, actorUserId);
    if (!approval.proposal) throw invalidPreview();
    if (approval.review && !acknowledgeReview) {
      throw new ConflictError('Acknowledge the review notes before creating a draft pull request.');
    }
    return this.#publishApproval(approval);
  }

  async runAutomatic(
    workspaceId: string,
    stackId: string,
    candidates: ImageUpdateIntent[],
    signal: AbortSignal,
    reportOnly = false,
  ): Promise<'skipped' | 'review' | 'ready' | 'published'> {
    signal.throwIfAborted();
    const stack = await this.stacks.findById(workspaceId, stackId);
    if (
      !stack ||
      !candidates.length ||
      candidates.length > MAX_IMAGE_UPDATE_CANDIDATES ||
      candidates.some((candidate) => candidate.source !== 'wud' || candidate.stackId !== stackId)
    )
      return 'skipped';
    const policyFile = await this.#read(stack, '', IMAGE_UPDATE_POLICY_PATH);
    if (!policyFile?.content) return 'skipped';
    const automation = parseImageUpdatePolicy(policyFile.content).automation;
    if (!automation) return 'skipped';
    const preview = await this.#planFile(stack, null, candidates, {
      stackId,
      stackName: stack.name,
      path: stack.composePath,
    });
    if (preview.status !== 'ready' || !preview.proposal || !preview.token) return 'review';
    const approval = this.#verify(preview.token, workspaceId, null);
    if (approval.commitSha !== policyFile.commitSha) return 'skipped';
    if (reportOnly || automation.mode === 'report') return 'ready';
    try {
      await this.#publishApproval(approval, signal);
    } catch (error) {
      if (isAppError(error) && error.code === 'image_update_pull_open') return 'skipped';
      throw error;
    }
    return 'published';
  }

  async #publishContext(approval: FileApproval) {
    const stack = await this.stacks.findById(approval.workspaceId, approval.stackId);
    if (!stack || stack.composePath !== approval.path) throw invalidPreview();
    const file = await this.#read(stack, stack.rootPath, approval.path);
    if (!file?.content || file.commitSha !== approval.commitSha || file.blobSha !== approval.blobSha) {
      throw new ConflictError('The Compose file changed. Preview the update again.');
    }
    if (!(await this.#currentCandidates(stack, approval.edits))) {
      throw new ConflictError('WUD no longer reports the reviewed tags. Preview the update again.');
    }
    return { stack, file };
  }

  async #publishApproval(approval: FileApproval, signal?: AbortSignal): Promise<ImageUpdatePublication> {
    const { stack, file } = await this.#publishContext(approval);
    const { policy, externalPolicy, groupsText } = await this.#loadPolicy(stack, approval.commitSha);
    if (!externalPolicy) throw invalidPreview();
    const changes = await this.#repositoryPlan(stack, file, approval.edits, groupsText);
    if (wudRepositoryPlanHash(changes) !== approval.nextContentHash) throw invalidPreview();
    const automation = policy.automation;
    if (approval.actorUserId === null && (automation?.mode !== 'publish' || approval.review))
      throw invalidPreview();
    return this.publication.publish(
      {
        workspaceId: stack.workspaceId,
        repositoryId: stack.repositoryId,
        commitSha: approval.commitSha,
        changes,
        review: approval.review,
        signal,
      },
      approval.actorUserId,
      automation?.author,
    );
  }

  async #stageApproval(
    workspaceId: string,
    actorUserId: string,
    approval: FileApproval,
    acknowledgeReview: boolean,
  ): Promise<StageFile> {
    const summary = { stackId: approval.stackId, stackName: 'Stack unavailable', path: approval.path };
    try {
      if (approval.proposal) return { ...summary, status: 'failed' };
      const stack = await this.stacks.findById(workspaceId, approval.stackId);
      summary.stackName = stack?.name ?? 'Stack removed';
      if (stack?.composePath !== approval.path) return { ...summary, status: 'source_changed' };
      if (approval.review && !acknowledgeReview) return { ...summary, status: 'review_required' };
      return { ...summary, status: await this.#stageFile(stack, approval, actorUserId) };
    } catch {
      return { ...summary, status: 'failed' };
    }
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
    const blocked = (reason: string, changes?: ImageUpdateReviewRow[]) =>
      blockedFile(summary, reason, changes);
    if (!stack) return blocked('This stack is unavailable in the workspace.');

    try {
      return await this.#planFile(stack, actorUserId, items, summary);
    } catch (error) {
      return blocked(isAppError(error) ? error.message : 'Could not review this Compose file.');
    }
  }

  async #planFile(
    stack: Stack,
    actorUserId: string | null,
    items: ImageUpdateIntent[],
    summary: Pick<PreviewFile, 'stackId' | 'stackName' | 'path'>,
  ): Promise<PreviewFile> {
    const file = await this.#read(stack, stack.rootPath, stack.composePath);
    if (!file?.content || !file.blobSha || file.locked)
      return blockedFile(summary, 'The committed Compose file is unavailable.');
    if (file.draft) return blockedFile(summary, 'This Compose file already has a draft.');
    const committed = file.content;
    const inventory = inspectStackImages(committed);
    if (!inventory) return blockedFile(summary, 'The committed Compose file could not be parsed.');
    const { policy, legacyChangelogs, externalPolicy, groupsText } = await this.#loadPolicy(
      stack,
      file.commitSha,
    );
    const suggestions = await this.#suggestions(stack, items, policy);
    const rows = await this.#reviewItems(stack.composePath, committed, items, inventory, suggestions, {
      policy,
      legacyChangelogs,
    });
    if (externalPolicy && !(await this.publication.available(stack.workspaceId, stack.repositoryId))) {
      return {
        ...blockedFile(
          summary,
          'Use your repository’s WUD update workflow to make this change. It handles Compose, related files, and version documentation together.',
          rows,
        ),
        repositoryWorkflow: true,
      };
    }
    const stageable = new Set(rows.filter((row) => row.status !== 'blocked').map((row) => row.service));
    if (!stageable.size) return blockedFile(summary, 'None of the selected updates can be staged.', rows);

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
    const { content, failures } = editComposeImages(committed, edits);
    if (failures.length) return blockedFile(summary, 'Could not prepare the selected edits.', rows);

    const review = rows.some((row) => row.status === 'review');
    const proposal = externalPolicy ? await this.#repositoryPlan(stack, file, edits, groupsText) : null;
    const token = this.#sign({
      workspaceId: stack.workspaceId,
      actorUserId,
      stackId: stack.id,
      path: stack.composePath,
      commitSha: file.commitSha,
      blobSha: file.blobSha,
      nextContentHash: proposal ? wudRepositoryPlanHash(proposal) : hash(content),
      edits,
      review,
      ...(proposal ? { proposal: true } : {}),
      expiresAt: this.clock.now().getTime() + PREVIEW_TTL_MS,
    });
    return {
      ...summary,
      status: review ? 'review' : 'ready',
      reason: null,
      changes: rows,
      token,
      ...(proposal ? { proposal: wudRepositoryDiff(proposal) } : {}),
    };
  }

  async #repositoryPlan(stack: Stack, file: FileView, edits: StageEdit[], groupsText: string | null) {
    if (groupsText === null || file.content === null) {
      throw new ConflictError('The repository update group policy or Compose file is unreadable.');
    }
    const { changes, failures } = editComposeImages(file.content, edits);
    if (failures.length) throw new ConflictError('The reviewed Compose changes no longer apply.');
    return planWudRepositoryUpdate(
      (path) => (path === file.path ? Promise.resolve(file) : this.#read(stack, '', path)),
      file.commitSha,
      parseWudUpdateGroups(groupsText),
      changes.map(({ service, before, after }) => ({ path: file.path, service, before, after })),
    );
  }

  async #loadPolicy(stack: Stack, commitSha: string) {
    const [config, externalGroups] = await Promise.all([
      this.#read(stack, '', IMAGE_UPDATE_POLICY_PATH),
      this.#read(stack, '', WUD_UPDATE_GROUPS_PATH),
    ]);
    if (
      (config && config.commitSha !== commitSha) ||
      (externalGroups && externalGroups.commitSha !== commitSha)
    ) {
      throw new ConflictError('The repository changed while loading its image update policy.');
    }
    if (config && (config.locked || config.content === null) && config.blobSha)
      throw new ConflictError('The committed image update policy is unreadable.');
    const catalog = externalGroups?.blobSha ? await this.#read(stack, '', WUD_CHANGELOG_CATALOG_PATH) : null;
    if (catalog && catalog.commitSha !== commitSha)
      throw new ConflictError('The repository changed while loading its changelog catalog.');
    return {
      policy: parseImageUpdatePolicy(config?.content ?? null),
      legacyChangelogs: readWudChangelogCatalog(catalog?.content ?? null),
      externalPolicy: !!externalGroups?.blobSha,
      groupsText: externalGroups?.locked ? null : (externalGroups?.content ?? null),
    };
  }

  async #suggestions(stack: Stack, items: ImageUpdateIntent[], policy: ImageUpdatePolicy) {
    if (!policy.sources.wud || !items.some((item) => item.source === 'wud')) {
      return new Map<string, StackImageUpdate>();
    }
    const wud = await this.wud.stack(stack.workspaceId, stack.id).catch(() => null);
    return new Map(
      wud?.images.filter((image) => image.status === 'available').map((image) => [image.name, image]),
    );
  }

  async #reviewItems(
    path: string,
    committed: string,
    items: ImageUpdateIntent[],
    inventory: SelectedImage[],
    suggestions: Map<string, StackImageUpdate>,
    config: { policy: ImageUpdatePolicy; legacyChangelogs: ChangelogCatalog },
  ): Promise<ImageUpdateReviewRow[]> {
    const byService = new Map(inventory.map((entry) => [entry.name, entry]));
    const { changes, failures } = editComposeImages(committed, items);
    const planned = new Map<string, ProposedEdit>();
    for (const change of changes) planned.set(change.service, change);
    for (const failure of failures) planned.set(failure.service, failure);
    // The preview limit bounds total changelog requests across all files in the batch.
    return Promise.all(
      items.map((intent) => {
        const image = byService.get(intent.service);
        const match = intent.source === 'wud' ? suggestions.get(intent.service) : undefined;
        const wud = match?.candidateTag === intent.targetTag ? match : undefined;
        return this.#review(path, intent, image, planned.get(intent.service), wud, config).catch(() =>
          blockedRow(intent, image, 'Could not review this image update.'),
        );
      }),
    );
  }

  async #review(
    path: string,
    intent: ImageUpdateIntent,
    image: SelectedImage | undefined,
    edit: ProposedEdit | undefined,
    wud: StackImageUpdate | undefined,
    { policy, legacyChangelogs }: { policy: ImageUpdatePolicy; legacyChangelogs: ChangelogCatalog },
  ): Promise<ImageUpdateReviewRow> {
    const blocked = (note: string) => blockedRow(intent, image, note);
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

    if (!edit) return blocked('The image value cannot be safely edited.');
    if ('reason' in edit) return blocked(edit.reason);
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
    return {
      service: intent.service,
      source: intent.source,
      before: image.image,
      after: edit.after,
      ...reviewEvidence(policy, evidence, isMajorChange(ref.tag, intent.targetTag), wud?.scanTimeUnavailable),
    };
  }

  async #stageFile(stack: Stack, approval: FileApproval, actorUserId: string): Promise<StageFile['status']> {
    const file = await this.#read(stack, stack.rootPath, approval.path);
    if (!file?.content || file.commitSha !== approval.commitSha || file.blobSha !== approval.blobSha)
      return 'source_changed';
    if (file.draft) return 'draft_exists';
    if (!(await this.#currentCandidates(stack, approval.edits))) return 'candidate_changed';
    const { content, failures } = editComposeImages(file.content, approval.edits);
    if (failures.length || hash(content) !== approval.nextContentHash) return 'source_changed';
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

  async #currentCandidates(stack: Stack, edits: StageEdit[]): Promise<boolean> {
    const wudEdits = edits.filter((edit) => edit.source === 'wud');
    if (!wudEdits.length) return true;
    const view = await this.wud.stack(stack.workspaceId, stack.id);
    return wudEdits.every((edit) =>
      view.images.some(
        (image) =>
          image.name === edit.service &&
          image.status === 'available' &&
          image.candidateTag === edit.targetTag &&
          (!image.scanTimeUnavailable || edit.scanTimeUnavailable === true),
      ),
    );
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

  #verify(token: string, workspaceId: string, actorUserId: string | null): FileApproval {
    const [body, mac, extra] = token.split('.');
    if (!body || !mac || extra !== undefined || !/^[a-zA-Z0-9_-]{43}$/.test(mac)) throw invalidPreview();
    if (!timingSafeEqual(Buffer.from(mac), Buffer.from(this.#mac(body)))) throw invalidPreview();
    const approval = JSON.parse(Buffer.from(body, 'base64url').toString()) as FileApproval;
    if (
      approval.workspaceId !== workspaceId ||
      approval.actorUserId !== actorUserId ||
      approval.expiresAt <= this.clock.now().getTime()
    )
      throw invalidPreview();
    return approval;
  }
}

const invalidPreview = () =>
  new ConflictError('This preview could not be verified. Preview the update again.');

function blockedFile(
  summary: Pick<PreviewFile, 'stackId' | 'stackName' | 'path'>,
  reason: string,
  changes: ImageUpdateReviewRow[] = [],
): PreviewFile {
  return { ...summary, status: 'blocked', reason, changes, token: null };
}

function blockedRow(
  intent: ImageUpdateIntent,
  image: SelectedImage | undefined,
  note: string,
): ImageUpdateReviewRow {
  return {
    service: intent.service,
    source: intent.source,
    before: image?.image ?? null,
    after: null,
    status: 'blocked',
    notes: [note],
    changelogUrl: null,
  };
}

function reviewEvidence(
  policy: ImageUpdatePolicy,
  evidence: Awaited<ReturnType<ChangelogReader['check']>> | null,
  major: boolean,
  scanTimeUnavailable: boolean | undefined,
): Pick<ImageUpdateReviewRow, 'status' | 'notes' | 'changelogUrl'> {
  const notes = [...(evidence?.signals ?? [])];
  const missing = evidence?.status !== 'checked';
  if (missing) notes.unshift(evidence?.detail || 'No changelog link was supplied.');
  if (major) notes.push('The image major version changes.');
  const risk = major || (evidence?.signals.length ?? 0) > 0;
  if (scanTimeUnavailable) notes.push('WUD supplied this tag without saying when it checked the registry.');
  const blocked = (missing && policy.missingEvidence === 'block') || (risk && policy.riskSignals === 'block');
  const status = notes.length ? 'review' : 'ready';
  return { status: blocked ? 'blocked' : status, notes, changelogUrl: evidence?.url || null };
}

function isMajorChange(currentTag: string, targetTag: string): boolean {
  const major = (tag: string) => /^v?(\d+)\.\d+(?:[.-]|$)/i.exec(tag)?.[1];
  return !!major(currentTag) && !!major(targetTag) && major(currentTag) !== major(targetTag);
}
