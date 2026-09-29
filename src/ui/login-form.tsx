'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, ApiError } from './api';
import { Field, FormError } from './form';
import { Button } from './primitives/button';

export function LoginForm({ next }: { next: string }) {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/api/auth/login', { method: 'POST', body: { username, password } });
      router.replace(next);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server.');
      setPassword('');
      setBusy(false);
    }
  }

  return (
    <form className="form" onSubmit={submit} noValidate>
      <FormError message={error} />
      <Field
        label="Username"
        name="username"
        value={username}
        onChange={setUsername}
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
        autoComplete="current-password"
        required
      />
      <div className="actions">
        <Button variant="primary" type="submit" disabled={!username || !password} loading={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </div>
    </form>
  );
}
