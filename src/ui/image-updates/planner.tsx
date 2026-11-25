'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useState, type FormEvent } from 'react';
import {
  MAX_IMAGE_UPDATE_CANDIDATES,
  type ImageUpdateIntent,
  type ImageUpdatePreview,
  type ImageUpdateStageResult,
} from '@/shared/image-update-planning';
import { isImageTag, type StackImageUpdate } from '@/shared/image-updates';
import { api, ApiError } from '@/ui/api';
import { Field, FormError } from '@/ui/form';
import { Alert } from '@/ui/primitives/alert';
import { Button } from '@/ui/primitives/button';

interface StackInventory {
  stackId: string;
  stackName: string;
  images: StackImageUpdate[];
}

interface FileSelection {
  selected: boolean;
  acknowledgeReview: boolean;
}

const previewLabels = { ready: 'Ready', review: 'Review required', blocked: 'Blocked' };
const stageLabels: Record<ImageUpdateStageResult['files'][number]['status'], string> = {
  staged: 'Draft saved',
  draft_exists: 'A draft already exists for this file',
  source_changed: 'The Compose source changed. Preview again.',
  candidate_changed: 'The WUD candidate changed. Preview again.',
  review_required: 'Acknowledge the review to save this draft',
  failed: 'Could not save this draft. Check Changes before retrying.',
};

function candidateKey({ stackId, service }: Pick<ImageUpdateIntent, 'stackId' | 'service'>) {
  return `${stackId}:${service}`;
}

function isHttpsUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

function errorMessage(error: unknown) {
  return error instanceof ApiError ? error.message : 'Could not reach Stack Manager.';
}

function mergeInventories(loaded: Record<string, StackInventory | string>, known: readonly StackInventory[]) {
  const inventories = new Map<string, StackInventory>();
  for (const stack of Object.values(loaded)) {
    if (typeof stack === 'object') inventories.set(stack.stackId, stack);
  }
  for (const stack of known) inventories.set(stack.stackId, stack);
  return [...inventories.values()];
}

export function ImageUpdatePlanner({
  workspaceId,
  stacks,
  known,
  initialStackId,
  repositoryWorkflow = false,
}: Readonly<{
  workspaceId: string;
  stacks: readonly { id: string; name: string }[];
  known: readonly StackInventory[];
  initialStackId?: string;
  repositoryWorkflow?: boolean;
}>) {
  const id = useId();
  const router = useRouter();
  const endpoint = `/api/workspaces/${workspaceId}/image-updates`;
  const stackEndpoint = `/api/workspaces/${workspaceId}/stacks`;
  const [stackId, setStackId] = useState(initialStackId ?? stacks[0]?.id ?? '');
  const [service, setService] = useState('');
  const [manualTag, setManualTag] = useState('');
  const [loaded, setLoaded] = useState<Record<string, StackInventory | string>>({});
  const [candidates, setCandidates] = useState<ImageUpdateIntent[]>([]);
  const [preview, setPreview] = useState<ImageUpdatePreview | null>(null);
  const [selected, setSelected] = useState<Record<string, FileSelection>>({});
  const [results, setResults] = useState<ImageUpdateStageResult['files']>([]);
  const [busy, setBusy] = useState<'preview' | 'stage' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');

  const inventory = known.find((stack) => stack.stackId === stackId) ?? loaded[stackId];
  const loadingStack = Boolean(stackId) && inventory === undefined;

  useEffect(() => {
    if (!loadingStack) return;
    let active = true;
    void api<StackInventory>(`${stackEndpoint}/${stackId}/image-updates`)
      .then((data) => {
        if (active) setLoaded((current) => ({ ...current, [stackId]: data }));
      })
      .catch((error: unknown) => {
        if (active) setLoaded((current) => ({ ...current, [stackId]: errorMessage(error) }));
      });
    return () => {
      active = false;
    };
  }, [loadingStack, stackEndpoint, stackId]);

  const candidateKeys = new Set(candidates.map(candidateKey));
  const services =
    typeof inventory === 'object'
      ? inventory.images.filter(
          (image) => image.image && !candidateKeys.has(candidateKey({ stackId, service: image.name })),
        )
      : [];
  const onlyService = services.length === 1 ? services[0]!.name : '';
  const selectedService = services.some((image) => image.name === service) ? service : onlyService;
  const inventories = mergeInventories(loaded, known);
  const suggestions = inventories.flatMap(({ stackId, images }) =>
    images.flatMap((image): ImageUpdateIntent[] => {
      if (image.status !== 'available' || !image.candidateTag) return [];
      const candidate = {
        stackId,
        service: image.name,
        targetTag: image.candidateTag,
        source: 'wud',
      } as const;
      const key = candidateKey(candidate);
      if (candidateKeys.has(key)) return [];
      candidateKeys.add(key);
      return [candidate];
    }),
  );
  const remaining = MAX_IMAGE_UPDATE_CANDIDATES - candidates.length;
  const hasDraftableFiles = preview?.files.some(({ token }) => token !== null) ?? false;
  const showManualForm = stacks.length > 1 || candidates.length === 0 || services.length > 0;
  const stageFiles = (preview?.files ?? []).flatMap(({ token, status }) => {
    if (!token || status === 'blocked') return [];
    const selection = selected[token];
    return selection?.selected && (status === 'ready' || selection.acknowledgeReview)
      ? [{ token, acknowledgeReview: selection.acknowledgeReview }]
      : [];
  });

  function changeCandidates(next: ImageUpdateIntent[], message = '') {
    setCandidates(next);
    setPreview(null);
    setError(null);
    setAnnouncement(message);
  }

  function addManual(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const targetTag = manualTag.trim();
    if (!remaining || !selectedService) return;
    if (!isImageTag(targetTag)) {
      setError('Enter a valid image tag.');
      return;
    }
    changeCandidates(
      [...candidates, { stackId, service: selectedService, targetTag, source: 'manual' }],
      `Added ${selectedService}.`,
    );
    setService('');
    setManualTag('');
  }

  function addSuggestions() {
    const additions = suggestions.slice(0, remaining);
    changeCandidates(
      [...candidates, ...additions],
      `Added ${additions.length} WUD ${additions.length === 1 ? 'suggestion' : 'suggestions'}.`,
    );
    if (additions.some((item) => item.stackId === stackId && item.service === selectedService)) {
      setService('');
      setManualTag('');
    }
  }

  async function previewUpdates(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const intents = candidates.map((item): ImageUpdateIntent => ({
      ...item,
      targetTag: item.targetTag.trim(),
      changelogUrl: item.changelogUrl?.trim() || undefined,
    }));
    const invalid = intents.find(
      (item) => !isImageTag(item.targetTag) || (item.changelogUrl && !isHttpsUrl(item.changelogUrl)),
    );
    if (invalid) {
      setError(`Check the image tag and optional HTTPS changelog URL for ${invalid.service}.`);
      return;
    }

    setBusy('preview');
    setError(null);
    setAnnouncement('');
    setPreview(null);
    setResults([]);
    try {
      const data = await api<ImageUpdatePreview>(`${endpoint}/preview`, {
        method: 'POST',
        body: { candidates: intents },
      });
      setPreview(data);
      setSelected(
        Object.fromEntries(
          data.files.flatMap(({ token, status }) =>
            token && status !== 'blocked'
              ? [[token, { selected: status === 'ready', acknowledgeReview: false }]]
              : [],
          ),
        ),
      );
      const canSave = data.files.some(({ token }) => token !== null);
      setAnnouncement(
        canSave
          ? 'Review the proposed changes below.'
          : 'Preview finished. See the next step for each file below.',
      );
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function stageUpdates(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!stageFiles.length) return;
    setBusy('stage');
    setError(null);
    setAnnouncement('');
    try {
      const data = await api<ImageUpdateStageResult>(`${endpoint}/stage`, {
        method: 'POST',
        body: { files: stageFiles },
      });
      setResults((current) => [
        ...current.filter(
          (file) =>
            !data.files.some((result) => result.stackId === file.stackId && result.path === file.path),
        ),
        ...data.files,
      ]);
      setSelected((current) => {
        const next = { ...current };
        for (const { token, acknowledgeReview } of stageFiles)
          next[token] = { selected: false, acknowledgeReview };
        return next;
      });
      const rejected = data.rejectedPreviews;
      setAnnouncement(
        rejected
          ? `Review the proposed updates again for ${rejected} expired or changed selections.`
          : 'Check the draft result for each file below.',
      );
      if (data.files.some((file) => file.status === 'staged')) router.refresh();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  if (!stacks.length) return <p className="muted">Add a stack to plan image updates.</p>;

  return (
    <div className="stack">
      {repositoryWorkflow ? (
        <Alert tone="info">
          <strong>Preview only for this repository.</strong> You can see the proposed tag and release notes
          here. Use your repository’s WUD update workflow to apply changes to Compose and its related files.
        </Alert>
      ) : (
        <p className="muted">Choose a new tag, review release notes, then save a draft in Changes.</p>
      )}
      {suggestions.length > 0 ? (
        <div className="actions">
          <Button disabled={!remaining || busy !== null} onClick={addSuggestions}>
            Add tags suggested by WUD ({suggestions.length})
          </Button>
        </div>
      ) : null}
      {showManualForm ? (
        <form className="form" aria-label="Add a manual image update" method="post" onSubmit={addManual}>
          <fieldset className="form" disabled={busy !== null}>
            <legend className="visually-hidden">Manual image update</legend>
            {stacks.length > 1 ? (
              <div className="field">
                <label htmlFor={`${id}-stack`}>Stack to edit</label>
                <select
                  id={`${id}-stack`}
                  name="stack"
                  value={stackId}
                  onChange={(event) => {
                    setStackId(event.target.value);
                    setService('');
                    setManualTag('');
                    setError(null);
                  }}
                >
                  {stacks.map((stack) => (
                    <option key={stack.id} value={stack.id}>
                      {stack.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            <div className="field">
              <label htmlFor={`${id}-service`}>Compose service to update</label>
              <select
                id={`${id}-service`}
                name="service"
                required
                value={selectedService}
                disabled={!services.length}
                onChange={(event) => setService(event.target.value)}
              >
                <option value="">{loadingStack ? 'Loading services…' : 'Choose a service'}</option>
                {services.map((image) => (
                  <option key={image.name} value={image.name}>
                    {image.name} ({image.image})
                  </option>
                ))}
              </select>
            </div>
            {typeof inventory === 'string' ? (
              <div className="actions">
                <FormError message={inventory} />
                <Button
                  onClick={() =>
                    setLoaded((current) => {
                      const next = { ...current };
                      delete next[stackId];
                      return next;
                    })
                  }
                >
                  Retry loading services
                </Button>
              </div>
            ) : null}
            {typeof inventory === 'object' && !services.length ? (
              <p className="muted">No more service images to add from this stack.</p>
            ) : null}
            <Field
              label="New image tag"
              name="manualTargetTag"
              required
              hint="Enter just the tag, for example 1.5.5."
              value={manualTag}
              onChange={(value) => {
                setManualTag(value);
                setError(null);
              }}
            />
            <div className="actions">
              <Button type="submit" disabled={!selectedService || remaining < 1}>
                Add tag to review
              </Button>
            </div>
            {remaining < 1 ? (
              <p className="muted">This batch has reached the {MAX_IMAGE_UPDATE_CANDIDATES}-image limit.</p>
            ) : null}
          </fieldset>
        </form>
      ) : null}

      {candidates.length ? (
        <form
          className="form"
          aria-label="Preview image updates"
          method="post"
          action={`${endpoint}/preview`}
          onSubmit={(event) => void previewUpdates(event)}
        >
          {candidates.map((item) => {
            const key = candidateKey(item);
            const stackName = stacks.find((stack) => stack.id === item.stackId)?.name ?? item.stackId;
            const update = (changes: Partial<ImageUpdateIntent>) =>
              changeCandidates(
                candidates.map((candidate) =>
                  candidate === item ? { ...candidate, ...changes } : candidate,
                ),
              );
            return (
              <fieldset key={key} className="form" disabled={busy !== null}>
                <legend>
                  <strong>
                    {stackName} / {item.service}
                  </strong>{' '}
                  <span className="muted">{item.source === 'wud' ? 'WUD suggestion' : 'Manual update'}</span>
                </legend>
                <Field
                  label="New image tag"
                  name={`tag-${key}`}
                  required
                  value={item.targetTag}
                  onChange={(targetTag) => {
                    if (targetTag !== item.targetTag) update({ targetTag, source: 'manual' });
                  }}
                />
                <Field
                  label="Release notes link (optional)"
                  name={`changelog-${key}`}
                  type="url"
                  inputMode="url"
                  hint="Use a page that lists both the tag saved in Git and the new tag. On GitHub, try the Releases list."
                  value={item.changelogUrl ?? ''}
                  onChange={(changelogUrl) => update({ changelogUrl })}
                />
                <div className="actions">
                  <Button
                    size="sm"
                    aria-label={`Remove ${item.service} from ${stackName}`}
                    onClick={() =>
                      changeCandidates(
                        candidates.filter((candidate) => candidate !== item),
                        `Removed ${item.service}.`,
                      )
                    }
                  >
                    Remove
                  </Button>
                </div>
              </fieldset>
            );
          })}
          <div className="actions">
            <Button variant="primary" type="submit" loading={busy === 'preview'} disabled={busy === 'stage'}>
              Review proposed updates
            </Button>
          </div>
        </form>
      ) : null}

      {preview ? (
        <form
          className="form"
          aria-label={hasDraftableFiles ? 'Save image update drafts' : 'Image update preview'}
          method="post"
          action={`${endpoint}/stage`}
          onSubmit={(event) => void stageUpdates(event)}
        >
          <h3>Review Compose changes</h3>
          {preview.files.map((file) => {
            const { token } = file;
            const selection = token ? selected[token] : undefined;
            const staged = results.some(
              (result) =>
                result.stackId === file.stackId && result.path === file.path && result.status === 'staged',
            );
            const updateSelection = (next: FileSelection) => {
              if (token) setSelected((current) => ({ ...current, [token]: next }));
            };
            return (
              <fieldset className="form" key={`${file.stackId}:${file.path}`} disabled={busy !== null}>
                <legend>
                  <strong>
                    {file.stackName} / <code>{file.path}</code>
                  </strong>{' '}
                  <span className="pill">
                    {file.repositoryWorkflow ? 'Preview only' : previewLabels[file.status]}
                  </span>
                </legend>
                {file.reason ? <p>{file.reason}</p> : null}
                {file.changes.length ? (
                  <ul className="stack">
                    {file.changes.map((change) => (
                      <li key={change.service}>
                        <strong>{change.service}</strong>{' '}
                        <span className="muted">
                          {file.repositoryWorkflow && change.status === 'review'
                            ? 'Check before updating'
                            : previewLabels[change.status]}
                        </span>
                        {change.before ? (
                          <p>
                            <code>{change.before}</code>
                            {change.after ? (
                              <>
                                {' '}
                                → <code>{change.after}</code>
                              </>
                            ) : null}
                          </p>
                        ) : null}
                        {change.notes.map((note, index) => (
                          <p key={`${index}-${note}`}>{note}</p>
                        ))}
                        {change.changelogUrl && isHttpsUrl(change.changelogUrl) ? (
                          <a href={change.changelogUrl} target="_blank" rel="noreferrer">
                            Release notes for {change.service}
                          </a>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {selection && !staged ? (
                  <label className="check-row">
                    <input
                      type="checkbox"
                      name="selectFile"
                      checked={selection.selected}
                      onChange={(event) =>
                        updateSelection({
                          selected: event.target.checked,
                          acknowledgeReview: file.status === 'review' && event.target.checked,
                        })
                      }
                    />{' '}
                    Include {file.path}
                    {file.status === 'review' ? ' and acknowledge review' : ''}
                  </label>
                ) : null}
              </fieldset>
            );
          })}
          {hasDraftableFiles ? (
            <div className="actions">
              <Button
                variant="primary"
                type="submit"
                loading={busy === 'stage'}
                disabled={!stageFiles.length || busy === 'preview'}
              >
                Save selected drafts
              </Button>
            </div>
          ) : null}
        </form>
      ) : null}

      {results.length ? (
        <ul className="stack" aria-label="Draft results">
          {results.map((file) => (
            <li key={`${file.stackId}:${file.path}`}>
              <strong>
                {file.stackName} / <code>{file.path}</code>
              </strong>{' '}
              {stageLabels[file.status]}
              {file.status === 'staged' ? (
                <>
                  {' '}
                  ·{' '}
                  <Link href={`/w/${workspaceId}/stacks/${file.stackId}/changes`}>
                    Open Changes for {file.stackName}
                  </Link>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="muted">
        <output>{announcement}</output>
      </p>
      <FormError message={error} />
    </div>
  );
}
