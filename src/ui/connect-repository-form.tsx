'use client';

import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { api, ApiError } from './api';
import { Field, FormError } from './form';

interface ProviderOption {
  type: string;
  displayName: string;
  exampleUrl: string;
  tokenHelp: string;
}

interface CredentialOption {
  id: string;
  label: string;
  hint: string;
  providerType: string;
}

type AccessMode = 'token' | 'none' | 'credential';

type TestResult =
  | { ok: true; defaultBranch: string | null; branches: string[]; branchCount: number }
  | { ok: false; reason: string; message: string };

export function ConnectRepositoryForm(props: {
  workspaceId: string;
  providers: ProviderOption[];
  credentials: CredentialOption[];
}) {
  const router = useRouter();
  const ids = { provider: useId(), access: useId(), branch: useId() };
  const [providerType, setProviderType] = useState(props.providers[0]?.type ?? '');
  const [remoteUrl, setRemoteUrl] = useState('');
  const [access, setAccess] = useState<AccessMode>('token');
  const [token, setToken] = useState('');
  const [username, setUsername] = useState('');
  const [credentialId, setCredentialId] = useState('');
  const [name, setName] = useState('');
  const [defaultBranch, setDefaultBranch] = useState('');
  const [test, setTest] = useState<TestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<'test' | 'save' | null>(null);

  const provider = props.providers.find((p) => p.type === providerType);
  const matchingCredentials = props.credentials.filter((c) => c.providerType === providerType);

  const auth = () =>
    access === 'token'
      ? { type: 'token' as const, token, username: username.trim() || undefined }
      : access === 'credential'
        ? { type: 'credential' as const, credentialId }
        : { type: 'none' as const };

  const resetResult = () => {
    setTest(null);
    setError(null);
  };

  async function runTest() {
    setBusy('test');
    setError(null);
    setFields({});
    try {
      const { result } = await api<{ result: TestResult }>(
        `/api/workspaces/${props.workspaceId}/repositories/test`,
        {
          method: 'POST',
          body: { gitProviderType: providerType, remoteUrl, auth: auth() },
        },
      );
      setTest(result);
      if (result.ok && !defaultBranch && result.defaultBranch) setDefaultBranch(result.defaultBranch);
    } catch (err) {
      setTest(null);
      if (err instanceof ApiError) {
        setError(err.message);
        setFields(err.fields);
      } else setError('Could not reach the server.');
    } finally {
      setBusy(null);
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy('save');
    setError(null);
    setFields({});
    try {
      const { repository } = await api<{ repository: { id: string } }>(
        `/api/workspaces/${props.workspaceId}/repositories`,
        {
          method: 'POST',
          body: {
            gitProviderType: providerType,
            remoteUrl,
            name: name.trim() || undefined,
            defaultBranch: defaultBranch.trim() || undefined,
            auth: auth(),
          },
        },
      );
      setToken('');
      router.replace(`/w/${props.workspaceId}/repositories/${repository.id}`);
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setFields(err.fields);
      } else setError('Could not reach the server.');
      setBusy(null);
    }
  }

  const canSubmit =
    !!providerType &&
    !!remoteUrl.trim() &&
    (access !== 'token' || !!token.trim()) &&
    (access !== 'credential' || !!credentialId) &&
    busy === null;

  return (
    <form className="form" onSubmit={save} noValidate>
      <FormError message={error} />

      <fieldset className="field">
        <legend id={ids.provider}>Git provider</legend>
        <div className="segmented" role="radiogroup" aria-labelledby={ids.provider}>
          {props.providers.map((p) => (
            <label key={p.type}>
              <input
                type="radio"
                name="provider"
                value={p.type}
                checked={providerType === p.type}
                onChange={() => {
                  setProviderType(p.type);
                  setCredentialId('');
                  resetResult();
                }}
              />
              {p.displayName}
            </label>
          ))}
        </div>
      </fieldset>

      <Field
        label="HTTPS clone URL"
        name="remoteUrl"
        type="url"
        inputMode="url"
        value={remoteUrl}
        onChange={(v) => {
          setRemoteUrl(v);
          resetResult();
        }}
        placeholder={provider?.exampleUrl}
        error={fields.remoteUrl}
        hint="HTTPS only. Never put a token in the URL — add it below and it will be stored encrypted."
        required
      />

      <fieldset className="field">
        <legend id={ids.access}>Access</legend>
        <div className="segmented" role="radiogroup" aria-labelledby={ids.access}>
          <label>
            <input
              type="radio"
              name="access"
              checked={access === 'token'}
              onChange={() => (setAccess('token'), resetResult())}
            />
            Access token
          </label>
          {matchingCredentials.length > 0 ? (
            <label>
              <input
                type="radio"
                name="access"
                checked={access === 'credential'}
                onChange={() => (setAccess('credential'), resetResult())}
              />
              Saved credential
            </label>
          ) : null}
          <label>
            <input
              type="radio"
              name="access"
              checked={access === 'none'}
              onChange={() => (setAccess('none'), resetResult())}
            />
            Public repository
          </label>
        </div>
      </fieldset>

      {access === 'token' ? (
        <>
          <Field
            label="Access token"
            name="token"
            type="password"
            value={token}
            onChange={(v) => {
              setToken(v);
              resetResult();
            }}
            error={fields.token ?? fields.secret}
            hint={provider?.tokenHelp}
            autoComplete="off"
            required
          />
          <Field
            label="Username (optional)"
            name="username"
            value={username}
            onChange={setUsername}
            hint="Only needed if your forge requires a specific username with the token."
            autoComplete="off"
          />
        </>
      ) : null}

      {access === 'credential' ? (
        <div className="field">
          <label htmlFor={`${ids.access}-cred`}>Credential</label>
          <select
            id={`${ids.access}-cred`}
            value={credentialId}
            onChange={(e) => {
              setCredentialId(e.target.value);
              resetResult();
            }}
          >
            <option value="">Choose a saved credential…</option>
            {matchingCredentials.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label} ({c.hint})
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <div className="actions">
        <button className="btn" type="button" onClick={runTest} disabled={!canSubmit}>
          {busy === 'test' ? 'Testing…' : 'Test connection'}
        </button>
        <span role="status" aria-live="polite">
          {test?.ok ? (
            <span className="pill ok">
              Reachable · {test.branchCount} branch{test.branchCount === 1 ? '' : 'es'}
            </span>
          ) : test && !test.ok ? (
            <span className="pill failed">{test.message}</span>
          ) : null}
        </span>
      </div>

      {test?.ok && test.branches.length > 0 ? (
        <div className="field">
          <label htmlFor={ids.branch}>Default branch</label>
          <select id={ids.branch} value={defaultBranch} onChange={(e) => setDefaultBranch(e.target.value)}>
            {test.branches.map((b) => (
              <option key={b} value={b}>
                {b}
                {b === test.defaultBranch ? ' (remote HEAD)' : ''}
              </option>
            ))}
          </select>
          {fields.defaultBranch ? <div className="error-text">{fields.defaultBranch}</div> : null}
        </div>
      ) : null}

      <Field
        label="Display name (optional)"
        name="name"
        value={name}
        onChange={setName}
        error={fields.name}
        hint="Defaults to the owner/repository path."
        spellCheck
      />

      <div className="actions">
        <button className="btn primary" type="submit" disabled={!canSubmit}>
          {busy === 'save' ? 'Connecting…' : 'Connect repository'}
        </button>
      </div>
      <p className="muted" style={{ fontSize: '0.85rem' }}>
        Connecting tests access, stores any token encrypted at rest, and clones the repository into the
        server’s data directory in the background.
      </p>
    </form>
  );
}
