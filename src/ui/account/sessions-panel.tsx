'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, ApiError } from '@/ui/api';
import { LocalTime } from '@/ui/local-time';
import { Alert } from '@/ui/primitives/alert';
import { Button } from '@/ui/primitives/button';
import { ConfirmButton } from '@/ui/primitives/confirm-button';
import { TableWrap } from '@/ui/primitives/table-wrap';

export type AccountSession = {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  userAgent: string | null;
  current: boolean;
};

export function SessionsPanel({ initialSessions }: { initialSessions: AccountSession[] }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [revokingOthers, setRevokingOthers] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const others = initialSessions.filter((s) => !s.current);
  const errorText = (err: unknown) => (err instanceof ApiError ? err.message : 'Could not reach the server.');

  async function revokeOne(sessionId: string) {
    setBusyId(sessionId);
    setError(null);
    try {
      await api(`/api/auth/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
      router.refresh();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusyId(null);
    }
  }

  async function revokeOthers() {
    setRevokingOthers(true);
    setError(null);
    try {
      await api('/api/auth/sessions', { method: 'DELETE' });
      router.refresh();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setRevokingOthers(false);
    }
  }

  if (initialSessions.length === 0) {
    return <p className="muted">No active sessions.</p>;
  }

  return (
    <div className="stack gap">
      {error ? (
        <Alert tone="error" role="alert">
          {error}
        </Alert>
      ) : null}
      {others.length > 0 ? (
        <div className="actions">
          <ConfirmButton
            label="Sign out everywhere else"
            confirmLabel="Sign out other sessions"
            description={`This keeps the current session and ends ${others.length} other ${others.length === 1 ? 'session' : 'sessions'}.`}
            onConfirm={revokeOthers}
            loading={revokingOthers}
          />
        </div>
      ) : null}
      <TableWrap labelledBy="ws-account-sessions">
        <table className="simple" aria-labelledby="ws-account-sessions">
          <thead>
            <tr>
              <th scope="col">Signed in</th>
              <th scope="col">Last seen</th>
              <th scope="col">Browser</th>
              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {initialSessions.map((s) => (
              <tr key={s.id}>
                <td>
                  <LocalTime iso={s.createdAt} />
                </td>
                <td>
                  <LocalTime iso={s.lastSeenAt} />
                </td>
                <td>
                  {s.userAgent ? (
                    <span className="mono fine-print" title={s.userAgent}>
                      {s.userAgent.length > 72 ? `${s.userAgent.slice(0, 72)}…` : s.userAgent}
                    </span>
                  ) : (
                    <span className="muted">Unknown</span>
                  )}
                </td>
                <td>
                  {s.current ? (
                    <span className="pill ready">Current</span>
                  ) : (
                    <Button
                      variant="danger"
                      size="sm"
                      loading={busyId === s.id}
                      disabled={busyId !== null && busyId !== s.id}
                      onClick={() => revokeOne(s.id)}
                    >
                      Revoke
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
    </div>
  );
}
