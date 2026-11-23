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
  staged: 'Draft staged',
  draft_exists: 'A draft already exists for this file',
  source_changed: 'The Compose source changed. Preview again.',
  candidate_changed: 'The WUD candidate changed. Preview again.',
  review_required: 'Acknowledge the review to stage this file',
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

export function ImageUpdatePlanner({
  workspaceId,
  stacks,
  known,
  initialStackId,
}: {
  workspaceId: string;
  stacks: { id: string; name: string }[];
  known: StackInventory[];
  initialStackId?: string;
}) {
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
  const inventories = new Map<string, StackInventory>();
  for (const stack of Object.values(loaded)) {
    if (typeof stack === 'object') inventories.set(stack.stackId, stack);
  }
  for (const stack of known) inventories.set(stack.stackId, stack);
  const suggestions = [...inventories.values()].flatMap(({ stackId, images }) =>
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
    if (!remaining || !services.some((image) => image.name === service)) return;
    if (!isImageTag(targetTag)) {
      setError('Enter a valid image tag.');
      return;
    }
    changeCandidates([...candidates, { stackId, service, targetTag, source: 'manual' }], `Added ${service}.`);
    setService('');
    setManualTag('');
  }

  function addSuggestions() {
    const additions = suggestions.slice(0, remaining);
    changeCandidates(
      [...candidates, ...additions],
      `Added ${additions.length} WUD ${additions.length === 1 ? 'suggestion' : 'suggestions'}.`,
    );
    if (additions.some((item) => item.stackId === stackId && item.service === service)) setService('');
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
      setAnnouncement('Preview ready. Review the proposed changes below.');
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
      setAnnouncement('Staging finished. Check the result for each file below.');
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
      <form className="form" aria-label="Add a manual image update" method="post" onSubmit={addManual}>
        <fieldset className="form" disabled={busy !== null}>
          <legend className="visually-hidden">Manual image update</legend>
          <div className="field">
            <label htmlFor={`${id}-stack`}>Stack</label>
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
          <div className="field">
            <label htmlFor={`${id}-service`}>Service</label>
            <select
              id={`${id}-service`}
              name="service"
              required
              value={service}
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
          ) : inventory && !services.length ? (
            <p className="muted">No more service images to add from this stack.</p>
          ) : null}
          <Field
            label="Target tag"
            name="manualTargetTag"
            required
            value={manualTag}
            onChange={(value) => {
              setManualTag(value);
              setError(null);
            }}
          />
          <div className="actions">
            <Button type="submit" disabled={!services.length || remaining < 1}>
              Add manual update
            </Button>
            {[...inventories.values()].some((stack) =>
              stack.images.some((image) => image.status === 'available'),
            ) ? (
              <Button disabled={!suggestions.length || remaining < 1} onClick={addSuggestions}>
                Add WUD suggestions
              </Button>
            ) : null}
          </div>
          {remaining < 1 ? (
            <p className="muted">This batch has reached the {MAX_IMAGE_UPDATE_CANDIDATES}-image limit.</p>
          ) : null}
        </fieldset>
      </form>

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
                  label="Target tag"
                  name={`tag-${key}`}
                  required
                  value={item.targetTag}
                  onChange={(targetTag) => {
                    if (targetTag !== item.targetTag) update({ targetTag, source: 'manual' });
                  }}
                />
                <Field
                  label="Changelog URL (optional)"
                  name={`changelog-${key}`}
                  type="url"
                  inputMode="url"
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
              Preview updates
            </Button>
          </div>
        </form>
      ) : null}

      {preview ? (
        <form
          className="form"
          aria-label="Stage image updates"
          method="post"
          action={`${endpoint}/stage`}
          onSubmit={(event) => void stageUpdates(event)}
        >
          <h3>Preview</h3>
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
                  <span className="pill">{previewLabels[file.status]}</span>
                </legend>
                {file.reason ? <p>{file.reason}</p> : null}
                {file.changes.length ? (
                  <ul className="stack">
                    {file.changes.map((change) => (
                      <li key={change.service}>
                        <strong>{change.service}</strong>{' '}
                        <span className="muted">{previewLabels[change.status]}</span>
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
                            Changelog for {change.service}
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
                    {file.status === 'review' ? 'Acknowledge and stage ' : 'Stage '}
                    {file.path}
                  </label>
                ) : null}
              </fieldset>
            );
          })}
          <div className="actions">
            <Button
              variant="primary"
              type="submit"
              loading={busy === 'stage'}
              disabled={!stageFiles.length || busy === 'preview'}
            >
              Stage selected files
            </Button>
          </div>
        </form>
      ) : null}

      {results.length ? (
        <ul className="stack" aria-label="Staging results">
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
      <p role="status" className="muted">
        {announcement}
      </p>
      <FormError message={error} />
    </div>
  );
}
