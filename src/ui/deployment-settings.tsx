'use client';

import { useEffect, useId, useRef, useState } from 'react';
import {
  DEFAULT_ROUTING_POLICY,
  validateRoutingPolicy,
  type RoutingDecision,
  type RoutingPolicy,
} from '@/shared/deployment-routing';
import { api, ApiError } from './api';
import { LocalTime } from './local-time';
import { Alert } from './primitives/alert';
import { Button } from './primitives/button';

type Provider = 'portainer-webhook' | 'generic-webhook';
type Binding = {
  id: string;
  providerType: Provider;
  enabled: boolean;
  deployOnPush: boolean;
  routingPolicy: RoutingPolicy | null;
  routingHeadSha: string | null;
  automationHold: boolean;
  revision: string;
  hint: string;
  lastTestedAt: string | null;
  lastTestStatus: 'ok' | 'failed' | null;
  lastTestMessage: string | null;
};
type Attempt = {
  id: string;
  providerType: Provider;
  requestedAt: string;
  triggerType: 'manual' | 'automatic';
  status: 'queued' | 'running' | 'accepted' | 'rejected' | 'unknown';
  httpStatus: number | null;
  failureReason: string | null;
};
type Decision = {
  id: string;
  explanation: string;
  reasonCode: string;
  decision: 'deploy' | 'skip' | 'blocked';
  createdAt: string;
  beforeSha: string | null;
  afterSha: string;
  attemptId: string | null;
  matchedPaths: string[];
};
type Message = { error: boolean; text: string } | null;
const providers: Record<Provider, string> = {
  'portainer-webhook': 'Portainer webhook',
  'generic-webhook': 'Generic HTTP webhook',
};

export function DeploymentSettings(
  props: Readonly<{
    workspaceId: string;
    stackId: string;
    stackName: string;
    composePath: string;
    settings: { binding: Binding | null };
    attempts: Attempt[];
    decisions: Decision[];
    workerEnabled: boolean;
  }>,
) {
  const id = useId();
  const url = useRef<HTMLInputElement>(null);
  const token = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const actionButton = useRef<HTMLButtonElement | null>(null);
  const inFlight = useRef(false);
  const [binding, setBinding] = useState(props.settings.binding);
  const [provider, setProvider] = useState<Provider>(binding?.providerType ?? 'portainer-webhook');
  const [enabled, setEnabled] = useState(binding?.enabled ?? true);
  const [attempts, setAttempts] = useState(props.attempts);
  const [decisions, setDecisions] = useState(props.decisions);
  const [deployOnPush, setDeployOnPush] = useState(binding?.deployOnPush ?? false);
  const initialPolicy = binding?.routingPolicy ?? {
    ...DEFAULT_ROUTING_POLICY,
    include: [...new Set([...DEFAULT_ROUTING_POLICY.include, props.composePath])],
  };
  const [rules, setRules] = useState({
    include: initialPolicy.include.join('\n'),
    exclude: initialPolicy.exclude.join('\n'),
    dependencies: initialPolicy.dependencies.join('\n'),
  });
  const [routingError, setRoutingError] = useState<string | null>(null);
  const [samplePaths, setSamplePaths] = useState('');
  const [preview, setPreview] = useState<RoutingDecision | null>(null);
  const [busy, setBusy] = useState(false);
  const [action, setAction] = useState<'trigger' | 'remove'>('trigger');
  const [message, setMessage] = useState<Message>(null);
  const endpoint = `/api/workspaces/${props.workspaceId}/stacks/${props.stackId}/deployment`;
  const active = attempts.some((attempt) => attempt.status === 'queued' || attempt.status === 'running');

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      void Promise.all([
        api<{ attempts: Attempt[]; decisions: Decision[] }>(`${endpoint}/history`),
        api<{ binding: Binding | null }>(endpoint),
      ])
        .then(([result, settings]) => {
          setAttempts(result.attempts);
          setDecisions(result.decisions);
          setBinding((current) =>
            current && settings.binding?.id === current.id && settings.binding.revision === current.revision
              ? { ...current, automationHold: settings.binding.automationHold }
              : current,
          );
        })
        .catch(() => {
          setMessage({
            error: true,
            text: 'Could not refresh deployment history. Reload to check the outcome before retrying.',
          });
        });
    }, 2000);
    return () => clearInterval(timer);
  }, [active, endpoint]);

  async function saveConfiguration(operation: 'save' | 'remove', routingPolicy?: RoutingPolicy) {
    let request: { method: string; body: unknown };
    if (operation === 'remove') {
      request = { method: 'DELETE', body: { expectedRevision: binding!.revision } };
    } else {
      let configuration: { url: string; bearerToken?: string } | undefined;
      if (url.current?.value) {
        configuration = { url: url.current.value };
        if (provider === 'generic-webhook' && token.current?.value) {
          configuration.bearerToken = token.current.value;
        }
      }
      request = {
        method: 'PUT',
        body: {
          providerType: provider,
          enabled,
          deployOnPush: enabled && deployOnPush,
          routingPolicy,
          expectedRevision: binding?.revision ?? null,
          configuration,
        },
      };
    }
    const value = await api<{ binding: Binding | null }>(endpoint, request);
    setBinding(value.binding);
    setDeployOnPush(value.binding?.deployOnPush ?? false);
    if (url.current) url.current.value = '';
    if (token.current) token.current.value = '';
    setMessage({
      error: false,
      text: operation === 'remove' ? 'Binding removed.' : 'Deployment binding saved.',
    });
  }

  async function mutate(operation: 'save' | 'trigger' | 'remove' | 'test' | 'preview') {
    if (inFlight.current || (active && operation === 'trigger')) return;
    if (operation === 'save' && token.current?.value && !url.current?.value) {
      setMessage({ error: true, text: 'Enter the replacement URL together with the bearer token.' });
      return;
    }
    let routingPolicy: RoutingPolicy | undefined;
    if (operation === 'save' || operation === 'preview') {
      try {
        routingPolicy = validateRoutingPolicy({
          include: rules.include.split(/\r?\n/).filter(Boolean),
          exclude: rules.exclude.split(/\r?\n/).filter(Boolean),
          dependencies: rules.dependencies.split(/\r?\n/).filter(Boolean),
        });
        setRoutingError(null);
      } catch (error) {
        setRoutingError(error instanceof Error ? error.message : 'Invalid routing policy.');
        setPreview(null);
        setMessage(null);
        return;
      }
    }
    inFlight.current = true;
    setBusy(true);
    setMessage(null);
    try {
      if (operation === 'preview') {
        setPreview(null);
        const result = await api<{ decision: RoutingDecision }>(`${endpoint}/preview`, {
          method: 'POST',
          body: { routingPolicy, paths: samplePaths.split(/\r?\n/).filter(Boolean) },
        });
        setPreview(result.decision);
      } else if (operation === 'trigger') {
        const result = await api<{ attempt: Attempt }>(`${endpoint}/trigger`, { method: 'POST', body: {} });
        setAttempts((previous) => [result.attempt, ...previous].slice(0, 20));
        setMessage({
          error: false,
          text: 'Deployment request recorded. HTTP acceptance does not verify container health.',
        });
      } else if (operation === 'test') {
        const result = await api<{ binding: Binding | null }>(`${endpoint}/test`, {
          method: 'POST',
          body: {},
        });
        if (result.binding?.id !== binding?.id || result.binding?.revision !== binding?.revision) {
          setMessage({
            error: true,
            text: 'Deployment settings changed. Reload before saving or deploying.',
          });
          return;
        }
        setBinding(result.binding);
      } else {
        await saveConfiguration(operation, routingPolicy);
      }
      dialog.current?.close();
    } catch (error) {
      setMessage({
        error: true,
        text:
          error instanceof ApiError
            ? error.message
            : 'Could not reach the server. Refresh history before retrying a deployment request.',
      });
      dialog.current?.close();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  function confirm(next: 'trigger' | 'remove', button: HTMLButtonElement) {
    actionButton.current = button;
    setAction(next);
    dialog.current?.showModal();
    cancel.current?.focus();
  }

  return (
    <div className="stack" aria-busy={busy}>
      <p>{binding ? `Configured (${binding.hint})` : 'Not configured'}</p>
      <p className="muted">
        Send deployment requests manually or after verified Git pushes. Acceptance does not verify deployment
        completion or container health.
      </p>
      {!props.workerEnabled ? (
        <Alert tone="info">The worker is disabled. Requests remain queued until it is enabled.</Alert>
      ) : null}
      {binding?.automationHold ? (
        <Alert tone="info">
          Automatic deployment is paused because a previous request has an unknown outcome. Verify the
          destination, then deliberately use Deploy now to resume automatic deployment.
        </Alert>
      ) : null}
      {active ? (
        <Alert tone="info">
          A deployment attempt is queued or running. New requests are locked until its outcome is recorded.
          Disable or rotate this binding to stop a queued request before it sends.
        </Alert>
      ) : null}
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          void mutate('save');
        }}
      >
        <fieldset disabled={busy} className="stack">
          <legend className="visually-hidden">Deployment binding</legend>
          <div className="field">
            <label htmlFor={`${id}-provider`}>Provider</label>
            <select
              id={`${id}-provider`}
              value={provider}
              onChange={(event) => setProvider(event.target.value as Provider)}
            >
              {Object.entries(providers).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={`${id}-url`}>{binding ? 'Replacement webhook URL' : 'Webhook URL'}</label>
            <input
              ref={url}
              id={`${id}-url`}
              type="password"
              autoComplete="off"
              spellCheck={false}
              required={!binding || provider !== binding.providerType}
              maxLength={4096}
              aria-describedby={`${id}-secret-hint`}
            />
            <p id={`${id}-secret-hint`} className="hint">
              Stored encrypted and never returned.{' '}
              {binding
                ? 'Leave blank to keep the existing secret. To rotate, enter the complete replacement URL and authentication.'
                : 'Use an HTTPS webhook URL.'}
            </p>
          </div>
          {provider === 'generic-webhook' ? (
            <div className="field">
              <label htmlFor={`${id}-token`}>Bearer token (optional)</label>
              <input
                ref={token}
                id={`${id}-token`}
                type="password"
                autoComplete="off"
                maxLength={16384}
                aria-describedby={`${id}-token-hint`}
              />
              <p id={`${id}-token-hint`} className="hint">
                Applies to a replacement URL only. Generic requests send POST with{' '}
                {'{"event":"deployment_requested"}'}.
              </p>
            </div>
          ) : null}
          <label className="check-row">
            <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />{' '}
            Binding enabled
          </label>
          <fieldset className="stack" aria-describedby={`${id}-routing-hint`}>
            <legend>Automatic deployment</legend>
            <label className="check-row">
              <input
                type="checkbox"
                checked={deployOnPush}
                onChange={(event) => setDeployOnPush(event.target.checked)}
              />{' '}
              Deploy automatically after verified Git pushes
            </label>
            <p className="hint">
              Off by default. Saving this option enables live future requests to the saved destination for
              matching verified pushes. Preview sends no deployment request.
            </p>
            <p id={`${id}-routing-hint`} className="hint">
              One pattern per line. Includes and exclusions are relative to the stack root; dependencies are
              relative to the repository root. Exclusions win, including over dependencies (checked against
              repository paths). Dependencies can match outside the stack. Empty includes match no stack-root
              paths. Supported wildcards: *, ? and whole-segment **.
            </p>
            {(['include', 'exclude', 'dependencies'] as const).map((field) => (
              <div className="field" key={field}>
                <label htmlFor={`${id}-${field}`}>
                  {field === 'include'
                    ? 'Include patterns'
                    : field === 'exclude'
                      ? 'Exclude patterns'
                      : 'Dependency patterns'}
                </label>
                <textarea
                  id={`${id}-${field}`}
                  rows={3}
                  spellCheck={false}
                  value={rules[field]}
                  aria-invalid={routingError ? true : undefined}
                  aria-describedby={routingError ? `${id}-routing-error` : `${id}-routing-hint`}
                  onChange={(event) => {
                    setRules({ ...rules, [field]: event.target.value });
                    setRoutingError(null);
                    setPreview(null);
                  }}
                />
              </div>
            ))}
            {routingError ? (
              <p id={`${id}-routing-error`} role="alert" className="error-text">
                {routingError}
              </p>
            ) : null}
            <div className="field">
              <label htmlFor={`${id}-paths`}>Sample changed paths</label>
              <textarea
                id={`${id}-paths`}
                rows={3}
                spellCheck={false}
                value={samplePaths}
                aria-describedby={`${id}-paths-hint`}
                onChange={(event) => {
                  setSamplePaths(event.target.value);
                  setPreview(null);
                }}
              />
              <p id={`${id}-paths-hint`} className="hint">
                Repository-relative paths, one per line. Uses the rules above without saving them.
              </p>
            </div>
            <Button onClick={() => void mutate('preview')}>Preview routing</Button>
            {preview ? (
              <output className="stack" aria-live="polite">
                <span>{preview.explanation}</span>
                <span className="hint">
                  {preview.reasonCode} ·{' '}
                  {preview.deployEligible ? 'Would match enabled automation' : 'No deployment request'}
                </span>
                {preview.matchedPaths.length ? (
                  <ul>
                    {preview.matchedPaths.map((path) => (
                      <li key={path}>{path}</li>
                    ))}
                  </ul>
                ) : null}
              </output>
            ) : null}
          </fieldset>
          <Button type="submit" variant="primary" loading={busy}>
            Save binding
          </Button>
        </fieldset>
      </form>
      <DestinationValidation binding={binding} busy={busy} onValidate={() => void mutate('test')} />
      <div className="actions">
        <Button
          variant="primary"
          disabled={busy || active || !binding?.enabled}
          onClick={(event) => confirm('trigger', event.currentTarget)}
        >
          Deploy now
        </Button>
        {binding ? (
          <Button
            variant="danger"
            disabled={busy}
            onClick={(event) => confirm('remove', event.currentTarget)}
          >
            Remove binding…
          </Button>
        ) : null}
      </div>
      <dialog
        ref={dialog}
        aria-labelledby={`${id}-dialog-title`}
        aria-describedby={`${id}-dialog-description`}
        onCancel={(event) => {
          if (busy) event.preventDefault();
        }}
        onClose={() => actionButton.current?.focus()}
        className="deployment-dialog"
      >
        <div className="stack">
          <h2 id={`${id}-dialog-title`}>
            {action === 'trigger' ? 'Confirm deployment request' : 'Remove deployment binding'}
          </h2>
          <p id={`${id}-dialog-description`}>
            {action === 'trigger'
              ? `Send a deployment request for ${props.stackName} through ${providers[binding?.providerType ?? provider]}? Confirming sends a live request to the configured destination.`
              : `Remove the deployment binding for ${props.stackName}? Its managed credential is cleaned up when no longer referenced.`}
          </p>
          <div className="actions">
            <Button ref={cancel} disabled={busy} onClick={() => dialog.current?.close()}>
              Cancel
            </Button>
            <Button
              variant={action === 'remove' ? 'danger' : 'primary'}
              loading={busy}
              onClick={() => void mutate(action)}
            >
              {action === 'trigger' ? 'Send deployment request' : 'Remove binding'}
            </Button>
          </div>
        </div>
      </dialog>
      <DeploymentHistory id={`${id}-history`} attempts={attempts} decisions={decisions} />
      <DeploymentFeedback message={message} />
    </div>
  );
}

function DeploymentHistory({
  id,
  attempts,
  decisions,
}: Readonly<{ id: string; attempts: Attempt[]; decisions: Decision[] }>) {
  return (
    <section aria-labelledby={id} className="stack">
      <h3 id={id}>Recent deployments</h3>
      {!attempts.length ? (
        <p className="muted">No deployment requests yet.</p>
      ) : (
        <ol className="stack">
          {attempts.map((attempt) => (
            <li key={attempt.id}>
              <LocalTime iso={attempt.requestedAt} /> ·{' '}
              {attempt.triggerType === 'automatic' ? 'Automatic' : 'Manual'} ·{' '}
              {providers[attempt.providerType]} ·{' '}
              <strong>{attempt.status.charAt(0).toUpperCase() + attempt.status.slice(1)}</strong>
              {attempt.httpStatus ? ` (HTTP ${attempt.httpStatus})` : ''}
              {attempt.failureReason ? <p>{attempt.failureReason}</p> : null}
              {attempt.status === 'unknown' ? (
                <p className="hint">
                  The destination may have received this request. Verify there before deliberately sending
                  another request.
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      )}
      <details>
        <summary>Recent routing decisions ({decisions.length})</summary>
        {!decisions.length ? (
          <p className="muted">No routing decisions yet.</p>
        ) : (
          <ol className="stack">
            {decisions.map((decision) => (
              <li key={decision.id}>
                <LocalTime iso={decision.createdAt} /> · <strong>{decision.decision}</strong>
                <p>{decision.explanation}</p>
                <p className="hint">
                  {decision.reasonCode} · {decision.beforeSha?.slice(0, 12) ?? 'Initial'} →{' '}
                  {decision.afterSha.slice(0, 12)}
                </p>
                {decision.matchedPaths.length ? (
                  <ul>
                    {decision.matchedPaths.map((path) => (
                      <li key={path}>{path}</li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </details>
    </section>
  );
}

function DeploymentFeedback({ message }: Readonly<{ message: Message }>) {
  if (!message) return null;
  return (
    <Alert tone={message.error ? 'error' : 'ok'} role={message.error ? 'alert' : 'status'}>
      {message.text}
    </Alert>
  );
}

function DestinationValidation({
  binding,
  busy,
  onValidate,
}: Readonly<{ binding: Binding | null; busy: boolean; onValidate: () => void }>) {
  return (
    <section aria-label="Destination validation" className="stack">
      <p className="hint">
        Checks saved configuration and DNS/network policy only. Sends no webhook; TLS and HTTP acceptance are
        not tested.
      </p>
      <Button disabled={busy || !binding} onClick={onValidate}>
        Validate destination
      </Button>
      {binding?.lastTestStatus ? (
        <output className="deployment-validation stack">
          <span>Destination validation: {binding.lastTestStatus === 'ok' ? 'Passed' : 'Failed'}</span>
          <span>
            <LocalTime iso={binding.lastTestedAt} />
          </span>
          {binding.lastTestMessage ? <span>{binding.lastTestMessage}</span> : null}
        </output>
      ) : null}
    </section>
  );
}
