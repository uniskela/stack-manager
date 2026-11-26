import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getContainer } from '@/server/container';
import { AuthShell } from '@/ui/auth-shell';
import { LoginForm } from '@/ui/login-form';
import { getSession } from '../_lib/session';

export const metadata: Metadata = { title: 'Sign in' };

/** Only same-app relative paths are honoured, preventing open redirects. */
function safeNext(value: string | string[] | undefined): string {
  const v = Array.isArray(value) ? value[0] : value;
  return v && v.startsWith('/') && !v.startsWith('//') && !v.startsWith('/\\') ? v : '/';
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[]>>;
}) {
  if (await getContainer().auth.isSetupRequired()) redirect('/setup');
  const next = safeNext((await searchParams).next);
  if (await getSession()) redirect(next);
  return (
    <AuthShell>
      <div className="card">
        <h1>Sign in</h1>
        <p className="muted">Use the admin account created when this instance was set up.</p>
        <LoginForm next={next} />
      </div>
    </AuthShell>
  );
}
