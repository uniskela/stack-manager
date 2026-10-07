'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, ApiError } from '@/ui/api';
import { Field, FormError } from '@/ui/form';
import { Alert } from '@/ui/primitives/alert';
import { Button } from '@/ui/primitives/button';

export function GitIdentityForm({
  initialName = '',
  initialEmail = '',
}: {
  initialName?: string;
  initialEmail?: string;
}) {
  const router = useRouter();
  const [name, setName] = useState(initialName);
  const [email, setEmail] = useState(initialEmail);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [success, setSuccess] = useState(false);
  const [busy, setBusy] = useState(false);

  const canSubmit = name.trim() && email.trim();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFields({});
    setSuccess(false);
    try {
      const result = await api<{ identity: { name: string; email: string } }>('/api/auth/git-identity', {
        method: 'PUT',
        body: { name, email },
      });
      setName(result.identity.name);
      setEmail(result.identity.email);
      setSuccess(true);
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setFields(err.fields);
      } else {
        setError('Could not reach the server.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="form" onSubmit={submit} noValidate>
      {success ? (
        <Alert tone="ok" role="status">
          Git identity saved.
        </Alert>
      ) : null}
      <FormError message={error} />
      <Field
        label="Name"
        name="gitAuthorName"
        value={name}
        onChange={setName}
        error={fields.name}
        autoComplete="name"
        required
      />
      <Field
        label="Email"
        name="gitAuthorEmail"
        type="email"
        value={email}
        onChange={setEmail}
        error={fields.email}
        autoComplete="email"
        required
      />
      <div className="actions">
        <Button variant="primary" type="submit" disabled={!canSubmit} loading={busy}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </form>
  );
}
