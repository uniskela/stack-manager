'use client';

import { useRouter } from 'next/navigation';
import { useId, useRef, useState } from 'react';
import { api, ApiError } from './api';
import { LocalTime } from './local-time';
import { Alert } from './primitives/alert';
import { Button } from './primitives/button';
import { ConfirmButton } from './primitives/confirm-button';

type Settings = { configured: boolean; hint: string | null; lastAcceptedAt: string | null };
const help: Record<string, { url: string; text: string }> = {
  github: {
    url: 'https://docs.github.com/en/webhooks/using-webhooks/creating-webhooks',
    text: 'GitHub: Settings → Webhooks → Add webhook. Select application/json and Just the push event.',
  },
  gitea: {
    url: 'https://docs.gitea.com/usage/repository/webhooks',
    text: 'Gitea: Settings → Webhooks → Add webhook → Gitea. Select POST, application/json and Push events.',
  },
  forgejo: {
    url: 'https://forgejo.org/docs/latest/user/repository/webhooks/',
    text: 'Forgejo: Settings → Webhooks → Add webhook → Forgejo. Select POST, application/json and Push events.',
  },
};

export function GitWebhookSettings(
  props: Readonly<{
    workspaceId: string;
    repositoryId: string;
    provider: string;
    providerName: string;
    publicUrl: string | null;
    settings: Settings;
    workerEnabled: boolean;
  }>,
) {
  const router = useRouter();
  const id = useId();
  const secret = useRef<HTMLInputElement>(null);
  const [settings, setSettings] = useState(props.settings);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const endpoint = `/api/workspaces/${props.workspaceId}/repositories/${props.repositoryId}/webhook`;
  const path = `/api/webhooks/git/${props.workspaceId}/${props.repositoryId}`;
  const [destination, setDestination] = useState(
    props.publicUrl ? new URL(path, props.publicUrl).href : path,
  );
  const instructions = help[props.provider];

  async function copy() {
    try {
      const url = new URL(path, props.publicUrl ?? window.location.origin).href;
      await navigator.clipboard.writeText(url);
      setDestination(url);
      setMessage({ error: false, text: 'Webhook URL copied.' });
    } catch {
      setMessage({ error: true, text: 'Copy unavailable. Select and copy the destination shown above.' });
    }
  }

  async function save(disable = false) {
    if (!disable && !secret.current?.reportValidity()) return;
    setBusy(true);
    setMessage(null);
    try {
      const value = await api<Settings>(
        endpoint,
        disable ? { method: 'DELETE' } : { method: 'PUT', body: { secret: secret.current!.value } },
      );
      setSettings(value);
      if (secret.current) secret.current.value = '';
      setMessage({
        error: false,
        text: disable
          ? 'Webhook disabled. Remove or disable it in your forge too.'
          : 'Signing secret saved. Set the same secret in your forge.',
      });
      router.refresh();
    } catch (err) {
      setMessage({
        error: true,
        text: err instanceof ApiError ? err.message : 'Could not reach the server.',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack" aria-busy={busy}>
      <dl className="meta-grid">
        <dt>Provider</dt>
        <dd>{props.providerName}</dd>
        <dt>Signing</dt>
        <dd>{settings.configured ? `Configured (${settings.hint})` : 'Disabled'}</dd>
        <dt>Destination URL</dt>
        <dd>
          <code>{destination}</code>
        </dd>
        <dt>Last accepted delivery</dt>
        <dd>
          <LocalTime iso={settings.lastAcceptedAt} />
        </dd>
      </dl>
      <div className="actions">
        <Button size="sm" onClick={copy}>
          Copy webhook URL
        </Button>
      </div>
      {!props.publicUrl ? (
        <p className="hint">
          Set STACK_MANAGER_PUBLIC_URL to your HTTPS address. Copy uses this browser’s origin until then.
        </p>
      ) : null}
      {instructions ? (
        <p>
          <a href={instructions.url} target="_blank" rel="noreferrer">
            {instructions.text}
          </a>{' '}
          Use the destination above and the same independently generated secret on both sides. Enable the
          hook.
        </p>
      ) : null}
      <p className="muted">
        A verified push to the tracked branch queues a background Git fetch. This updates Git source state; it
        does not deploy stacks or verify container health. Scheduled polling remains a fallback.
      </p>
      {!props.workerEnabled ? (
        <Alert tone="info">
          The worker is disabled. Accepted deliveries remain queued until it is enabled.
        </Alert>
      ) : null}
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!settings.configured) void save();
        }}
      >
        <div className="field">
          <label htmlFor={`${id}-secret`}>
            {settings.configured ? 'New signing secret' : 'Signing secret'}
          </label>
          <input
            ref={secret}
            id={`${id}-secret`}
            type="password"
            autoComplete="off"
            minLength={32}
            maxLength={16384}
            required
            disabled={busy}
            aria-describedby={`${id}-hint`}
          />
          <p id={`${id}-hint`} className="hint">
            Use at least 32 randomly generated characters. Stored encrypted and never returned. Rotation
            immediately invalidates the previous secret.
          </p>
        </div>
        {settings.configured ? (
          <ConfirmButton
            label="Rotate signing secret…"
            confirmLabel="Confirm rotation"
            description="The previous secret stops working immediately. Update the forge to the new secret after saving."
            onConfirm={() => save()}
            disabled={busy}
            loading={busy}
          />
        ) : (
          <Button type="submit" loading={busy}>
            Save signing secret
          </Button>
        )}
      </form>
      {settings.configured ? (
        <ConfirmButton
          label="Disable webhook…"
          confirmLabel="Confirm disable"
          description="Future deliveries will be rejected. Already queued fetches continue."
          onConfirm={() => save(true)}
          disabled={busy}
          loading={busy}
        />
      ) : null}
      <p className="hint">
        For failed deliveries, inspect the forge’s delivery history and HTTP status. Unauthenticated failure
        details are not stored in Stack Manager.{' '}
        <a href="https://uniskela.com/docs/stack-manager/git-webhooks">Setup and troubleshooting</a>.
      </p>
      {message ? (
        <Alert tone={message.error ? 'error' : 'ok'} role={message.error ? 'alert' : 'status'}>
          {message.text}
        </Alert>
      ) : null}
    </div>
  );
}
