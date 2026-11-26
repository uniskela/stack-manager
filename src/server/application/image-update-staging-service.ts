import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { editComposeImages } from '@/shared/compose-image-edits';
import {
  MAX_IMAGE_UPDATE_CANDIDATES,
  type ImageUpdateIntent,
  type ImageUpdatePublication,
  type ImageUpdatePredecessor,
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
import { readConcurrently } from './read-concurrently';
import type { SourceService } from './source-service';
import type { WudImageUpdatePublication } from './wud-image-update-publication';
import {
  planWudRepositoryUpdate,
  wudRepositoryDiff,
  wudRepositoryPlanHash,
  WUD_TECH_STACK_PATHS,
} from './wud-repository-plan';
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
type ApprovalSource = { stackId: string; path: string; blobSha: string; edits: StageEdit[] };
type ProposalSource = {
  stack: Stack;
  file: FileView & { content: string; blobSha: string };
  groupsText: string | null;
  edits: StageEdit[];
  rows: ImageUpdateReviewRow[];
};
type ProposedEdit = { after: string } | { reason: string };
const PORTAINER_WUD_SKILL_PATH = '.opencode/skills/portainer-wud-updates/SKILL.md';
const PREVIEW_TTL_MS = 20 * 60_000;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

interface FileApproval extends ApprovalSource {
  workspaceId: string;
  actorUserId: string | null;
  commitSha: string;
  nextContentHash: string;
  review: boolean;
  proposal?: true;
  repositoryId?: string;
  additionalSources?: ApprovalSource[];
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
    return policy?.blobSha ? !(await this.#canPlanNativeProposal(stack, policy.commitSha)) : false;
  }

  async repositoryWorkflowGuide(workspaceId: string, stackId: string) {
    const stack = await this.stacks.findById(workspaceId, stackId);
    if (!stack) return null;
    const policy = await this.#read(stack, '', WUD_UPDATE_GROUPS_PATH);
    if (!policy?.blobSha) return null;
    const native = await this.#canPlanNativeProposal(stack, policy.commitSha);
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
    preferPull = false,
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
        this.#previewFile(workspaceId, actorUserId, stackId, items, preferPull).catch(() =>
          blockedFile({ stackId, stackName: 'Stack unavailable', path: '' }, 'Could not load this stack.'),
        ),
      ),
    );
    const previews: PreviewFile[] = [];
    const groups = new Map<string, ProposalSource[]>();
    for (const entry of files) {
      if ('stack' in entry) {
        const group = groups.get(entry.stack.repositoryId) ?? [];
        group.push(entry);
        groups.set(entry.stack.repositoryId, group);
      } else previews.push(entry);
    }
    // Each repository preview can read up to 24 linked files.
    const proposals = await readConcurrently([...groups.values()], 2, (sources) =>
      this.#proposalPreview(actorUserId, sources).catch((error) =>
        blockedFile(
          proposalSummary(sources),
          isAppError(error) ? error.message : 'Could not plan this pull request.',
        ),
      ),
    );
    return { files: [...previews, ...proposals] };
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
    { token, acknowledgeReview, supersede }: StageRequest & { supersede?: ImageUpdatePredecessor },
  ): Promise<ImageUpdatePublication> {
    const approval = this.#verify(token, workspaceId, actorUserId);
    if (!approval.proposal) throw invalidPreview();
    if (approval.review && !acknowledgeReview) {
      throw new ConflictError('Acknowledge the review notes before creating a draft pull request.');
    }
    return this.#publishApproval(approval, undefined, supersede);
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
    const planned = await this.#planFile(stack, null, candidates, {
      stackId,
      stackName: stack.name,
      path: stack.composePath,
    });
    const preview = 'stack' in planned ? await this.#proposalPreview(null, [planned]) : planned;
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

  async #publishContext(approval: FileApproval, source: ApprovalSource) {
    const stack = await this.stacks.findById(approval.workspaceId, source.stackId);
    if (
      stack?.composePath !== source.path ||
      (approval.repositoryId && stack.repositoryId !== approval.repositoryId)
    )
      throw invalidPreview();
    const file = await this.#read(stack, stack.rootPath, source.path);
    if (
      !file?.content ||
      file.commitSha !== approval.commitSha ||
      file.blobSha !== source.blobSha ||
      file.draft
    ) {
      throw new ConflictError('The Compose file changed. Preview the update again.');
    }
    if (!(await this.#currentCandidates(stack, source.edits))) {
      throw new ConflictError('WUD no longer reports the reviewed tags. Preview the update again.');
    }
    return { stack, file, edits: source.edits };
  }

  async #publishApproval(
    approval: FileApproval,
    signal?: AbortSignal,
    supersede?: ImageUpdatePredecessor,
  ): Promise<ImageUpdatePublication> {
    const sources = await Promise.all(
      [approval, ...(approval.additionalSources ?? [])].map((source) =>
        this.#publishContext(approval, source),
      ),
    );
    const { stack } = sources[0]!;
    const { policy, groupsText, externalPolicy } = await this.#loadPolicy(stack, approval.commitSha);
    if (externalPolicy && groupsText === null) throw invalidPreview();
    const { changes, reviewNotes } = await this.#repositoryPlan(sources, groupsText);
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
        supersede,
        review: approval.review,
        reviewNotes,
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
    preferPull: boolean,
  ): Promise<PreviewFile | ProposalSource> {
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
      return await this.#planFile(stack, actorUserId, items, summary, preferPull);
    } catch (error) {
      return blocked(isAppError(error) ? error.message : 'Could not review this Compose file.');
    }
  }

  async #planFile(
    stack: Stack,
    actorUserId: string | null,
    items: ImageUpdateIntent[],
    summary: Pick<PreviewFile, 'stackId' | 'stackName' | 'path'>,
    preferPull = false,
  ): Promise<PreviewFile | ProposalSource> {
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
    if (externalPolicy && !(await this.#canPlanNativeProposal(stack, file.commitSha))) {
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

    const composePullAvailable =
      !externalPolicy &&
      actorUserId !== null &&
      (await this.publication.available(stack.workspaceId, stack.repositoryId));
    if (externalPolicy || (preferPull && composePullAvailable)) {
      if (externalPolicy && groupsText === null) throw invalidPreview();
      return { stack, file: { ...file, content: committed, blobSha: file.blobSha }, groupsText, edits, rows };
    }
    const review = rows.some((row) => row.status === 'review');
    const token = this.#sign({
      workspaceId: stack.workspaceId,
      actorUserId,
      stackId: stack.id,
      path: stack.composePath,
      commitSha: file.commitSha,
      blobSha: file.blobSha,
      nextContentHash: hash(content),
      edits,
      review,
      expiresAt: this.clock.now().getTime() + PREVIEW_TTL_MS,
    });
    return {
      ...summary,
      status: review ? 'review' : 'ready',
      reason: null,
      ...(composePullAvailable ? { composePullAvailable: true as const } : {}),
      changes: rows,
      token,
    };
  }

  async #proposalPreview(actorUserId: string | null, sources: ProposalSource[]): Promise<PreviewFile> {
    const { stack, file, groupsText } = sources[0]!;
    const { changes, reviewNotes } = await this.#repositoryPlan(sources, groupsText);
    const rows = sources.flatMap((source) =>
      source.rows.map((row) => (sources.length === 1 ? row : { ...row, stackName: source.stack.name })),
    );
    const review = rows.some((row) => row.status === 'review') || reviewNotes.length > 0;
    const [first, ...additionalSources] = sources.map(({ stack, file, edits }) => ({
      stackId: stack.id,
      path: stack.composePath,
      blobSha: file.blobSha,
      edits,
    }));
    return {
      ...proposalSummary(sources),
      changes: rows,
      status: review ? 'review' : 'ready',
      reason: reviewNotes.join(' ') || null,
      proposal: wudRepositoryDiff(changes),
      token: this.#sign({
        ...first!,
        additionalSources,
        workspaceId: stack.workspaceId,
        repositoryId: stack.repositoryId,
        actorUserId,
        commitSha: file.commitSha,
        proposal: true,
        review,
        nextContentHash: wudRepositoryPlanHash(changes),
        expiresAt: this.clock.now().getTime() + PREVIEW_TTL_MS,
      }),
    };
  }

  async #canPlanNativeProposal(stack: Stack, commitSha: string): Promise<boolean> {
    if (!(await this.publication.available(stack.workspaceId, stack.repositoryId))) return false;
    const documents = await Promise.allSettled(
      WUD_TECH_STACK_PATHS.map((path) => this.#read(stack, '', path)),
    );
    return documents.every((result) => {
      const file = result.status === 'fulfilled' ? result.value : null;
      return file?.commitSha === commitSha && !!file.blobSha && !file.locked && file.content !== null;
    });
  }

  async #repositoryPlan(
    sources: { stack: Stack; file: FileView; edits: StageEdit[] }[],
    groupsText: string | null,
  ) {
    const { stack, file: first } = sources[0]!;
    const selected = sources.flatMap(({ file, edits }) => {
      if (file.content === null || file.commitSha !== first.commitSha) throw invalidPreview();
      const { changes, failures } = editComposeImages(file.content, edits);
      if (failures.length) throw new ConflictError('The reviewed Compose changes no longer apply.');
      return changes.map(({ service, before, after }) => ({ path: file.path, service, before, after }));
    });
    const files = new Map(sources.map(({ file }) => [file.path, file]));
    return planWudRepositoryUpdate(
      async (path) => files.get(path) ?? this.#read(stack, '', path),
      first.commitSha,
      groupsText === null ? null : parseWudUpdateGroups(groupsText),
      selected,
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

function proposalSummary(sources: ProposalSource[]) {
  const { stack } = sources[0]!;
  return {
    stackId: stack.id,
    stackName: sources.length === 1 ? stack.name : sources.map((source) => source.stack.name).join(', '),
    path: sources.length === 1 ? stack.composePath : `${sources.length} stacks · one pull request`,
  };
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
