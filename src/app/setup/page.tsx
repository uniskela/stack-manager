import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getContainer } from '@/server/container';
import { Brand } from '@/ui/brand';
import { Steps } from '@/ui/form';
import { SetupForm } from '@/ui/setup-form';

export const metadata: Metadata = { title: 'Set up' };

export default async function SetupPage() {
  const { auth } = getContainer();
  if (!(await auth.isSetupRequired())) redirect('/login');
  return (
    <main className="center-shell">
      <div className="auth-card">
        <Brand />
        <Steps current={1} />
        <div className="card">
          <h1>Create the admin account</h1>
          <p className="muted">
            This account manages repositories and provider credentials for this instance. You can connect your
            Compose repository next.
          </p>
          <SetupForm setupTokenRequired={auth.setupTokenRequired} />
        </div>
      </div>
    </main>
  );
}
