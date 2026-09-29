'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, ApiError } from './api';
import { Field, FormError } from './form';
import { Button } from './primitives/button';

export function SetupForm({ setupTokenRequired }: { setupTokenRequired: boolean }) {
  const router = useRouter();
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [setupToken, setSetupToken] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setFields({});
    if (password !== confirm) {
      setFields({ confirm: 'Passwords do not match.' });
      return;
    }
    setBusy(true);
    try {
      await api('/api/setup', {
        method: 'POST',
        body: { username, password, setupToken: setupTokenRequired ? setupToken : undefined },
      });
      router.replace('/onboarding');
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError) {
        setFields(err.fields);
        setError(err.code === 'setup_complete' ? 'Setup is already complete. Sign in instead.' : err.message);
      } else setError('Could not reach the server.');
      setBusy(false);
    }
  }

  return (
    <form className="form" onSubmit={submit} noValidate>
      <FormError message={error} />
      {setupTokenRequired ? (
        <Field
          label="Setup token"
          name="setupToken"
          type="password"
          value={setupToken}
          onChange={setSetupToken}
          hint="The value of STACK_MANAGER_SETUP_TOKEN from your deployment."
          autoComplete="off"
          required
        />
      ) : null}
      <Field
        label="Admin username"
        name="username"
        value={username}
        onChange={setUsername}
        error={fields.username}
        autoComplete="username"
        required
        autoFocus
      />
      <Field
        label="Password"
        name="password"
        type="password"
        value={password}
        onChange={setPassword}
        error={fields.password}
        hint="At least 12 characters. A passphrase works well."
        autoComplete="new-password"
        required
      />
      <Field
        label="Confirm password"
        name="confirm"
        type="password"
        value={confirm}
        onChange={setConfirm}
        error={fields.confirm}
        autoComplete="new-password"
        required
      />
      <div className="actions">
        <Button variant="primary" type="submit" loading={busy}>
          {busy ? 'Creating account…' : 'Create admin account'}
        </Button>
      </div>
    </form>
  );
}
