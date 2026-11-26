import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getContainer } from '@/server/container';
import { AuthShell } from '@/ui/auth-shell';
import { Steps } from '@/ui/form';
import { CreateWorkspaceForm } from '@/ui/workspace-form';
import { requireSession } from '../_lib/session';

export const metadata: Metadata = { title: 'Name your workspace' };

export default async function OnboardingPage() {
  await requireSession();
  const [existing] = await getContainer().workspaces.list();
  if (existing) redirect(`/w/${existing.id}`);
  return (
    <AuthShell>
      <Steps current={2} />
      <div className="card">
        <h1>Name your workspace</h1>
        <p className="muted">
          A workspace groups the Git repositories that describe your stacks, and the credentials used to reach
          them.
        </p>
        <CreateWorkspaceForm />
      </div>
    </AuthShell>
  );
}
