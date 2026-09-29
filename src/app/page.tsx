import { redirect } from 'next/navigation';
import { getContainer } from '@/server/container';
import { requireSession } from './_lib/session';

export default async function Home() {
  await requireSession();
  const workspaces = await getContainer().workspaces.list();
  const first = workspaces[0];
  redirect(first ? `/w/${first.id}` : '/onboarding');
}
