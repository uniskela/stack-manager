'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { api, ApiError } from './api';
import { LocalTime } from './local-time';
import { Alert } from './primitives/alert';
import { Button } from './primitives/button';

type Provider = 'portainer-webhook' | 'generic-webhook';
type Binding = { id: string; providerType: Provider; enabled: boolean; revision: string; hint: string };
type Attempt = {
  id: string;
  providerType: Provider;
  requestedAt: string;
  status: 'queued' | 'running' | 'accepted' | 'rejected' | 'unknown';
  httpStatus: number | null;
  failureReason: string | null;
};
const providers: Record<Provider, string> = {
  'portainer-webhook': 'Portainer webhook',
  'generic-webhook': 'Generic HTTP webhook',
};

export function DeploymentSettings(
  props: Readonly<{
    workspaceId: string;
    stackId: string;
    stackName: string;
    settings: { binding: Binding | null };
    attempts: Attempt[];
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
  const [busy, setBusy] = useState(false);
  const [action, setAction] = useState<'trigger' | 'remove'>('trigger');
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const endpoint = `/api/workspaces/${props.workspaceId}/stacks/${props.stackId}/deployment`;
  const active = attempts.some((attempt) => attempt.status === 'queued' || attempt.status === 'running');

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      void api<{ attempts: Attempt[] }>(`${endpoint}/history`)
        .then((result) => setAttempts(result.attempts))
        .catch(() => {
          setMessage({
            error: true,
            text: 'Could not refresh deployment history. Reload to check the outcome before retrying.',
          });
        });
    }, 2000);
    return () => clearInterval(timer);
  }, [active, endpoint]);

  async function mutate(operation: 'save' | 'trigger' | 'remove') {
    if (inFlight.current || (active && operation === 'trigger')) return;
    if (operation === 'save' && token.current?.value && !url.current?.value) {
      setMessage({ error: true, text: 'Enter the replacement URL together with the bearer token.' });
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setMessage(null);
    try {
      if (operation === 'trigger') {
        const result = await api<{ attempt: Attempt }>(`${endpoint}/trigger`, { method: 'POST', body: {} });
        setAttempts((previous) => [result.attempt, ...previous].slice(0, 20));
        setMessage({
          error: false,
          text: 'Deployment request recorded. HTTP acceptance does not verify container health.',
        });
      } else {
        const value = await api<{ binding: Binding | null }>(
          endpoint,
          operation === 'remove'
            ? { method: 'DELETE', body: { expectedRevision: binding!.revision } }
            : {
                method: 'PUT',
                body: {
                  providerType: provider,
                  enabled,
                  deployOnPush: false,
                  expectedRevision: binding?.revision ?? null,
                  ...(url.current?.value
                    ? {
                        configuration: {
                          url: url.current.value,
                          ...(provider === 'generic-webhook' && token.current?.value
                            ? { bearerToken: token.current.value }
                            : {}),
                        },
                      }
                    : {}),
                },
              },
        );
        setBinding(value.binding);
        if (url.current) url.current.value = '';
        if (token.current) token.current.value = '';
        setMessage({
          error: false,
          text: operation === 'remove' ? 'Binding removed.' : 'Deployment binding saved.',
        });
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
        Send a deliberate deployment request for this stack. Acceptance does not verify deployment completion
        or container health.
      </p>
      {!props.workerEnabled ? (
        <Alert tone="info">The worker is disabled. Requests remain queued until it is enabled.</Alert>
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
          <p className="hint">
            Automatic deployment: Off — unavailable until automatic routing is implemented.
          </p>
          <Button type="submit" variant="primary" loading={busy}>
            Save binding
          </Button>
        </fieldset>
      </form>
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
      <section aria-labelledby={`${id}-history`} className="stack">
        <h3 id={`${id}-history`}>Recent deployments</h3>
        {!attempts.length ? (
          <p className="muted">No deployment requests yet.</p>
        ) : (
          <ol className="stack">
            {attempts.map((attempt) => (
              <li key={attempt.id}>
                <LocalTime iso={attempt.requestedAt} /> · {providers[attempt.providerType]} ·{' '}
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
      </section>
      {message ? (
        <Alert tone={message.error ? 'error' : 'ok'} role={message.error ? 'alert' : 'status'}>
          {message.text}
        </Alert>
      ) : null}
    </div>
  );
}
