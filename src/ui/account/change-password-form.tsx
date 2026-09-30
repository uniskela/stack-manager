'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, ApiError } from '@/ui/api';
import { Field, FormError } from '@/ui/form';
import { Alert } from '@/ui/primitives/alert';
import { Button } from '@/ui/primitives/button';

export function ChangePasswordForm() {
  const router = useRouter();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [success, setSuccess] = useState(false);
  const [busy, setBusy] = useState(false);

  const canSubmit = currentPassword && newPassword && confirmPassword;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFields({});
    setSuccess(false);
    try {
      await api('/api/auth/password', {
        method: 'POST',
        body: { currentPassword, newPassword, confirmPassword },
      });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
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
          Password updated. Other sessions were signed out.
        </Alert>
      ) : null}
      <FormError message={error} />
      <Field
        label="Current password"
        name="currentPassword"
        type="password"
        value={currentPassword}
        onChange={setCurrentPassword}
        error={fields.currentPassword}
        autoComplete="current-password"
        required
      />
      <Field
        label="New password"
        name="newPassword"
        type="password"
        value={newPassword}
        onChange={setNewPassword}
        error={fields.newPassword ?? fields.password}
        hint="At least 12 characters. A passphrase works well."
        autoComplete="new-password"
        required
      />
      <Field
        label="Confirm new password"
        name="confirmPassword"
        type="password"
        value={confirmPassword}
        onChange={setConfirmPassword}
        error={fields.confirmPassword}
        autoComplete="new-password"
        required
      />
      <div className="actions">
        <Button variant="primary" type="submit" disabled={!canSubmit} loading={busy}>
          {busy ? 'Updating…' : 'Update password'}
        </Button>
      </div>
    </form>
  );
}
