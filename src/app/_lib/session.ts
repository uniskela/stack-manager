import 'server-only';
import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import type { AuthenticatedSession } from '@/server/application/auth-service';
import { getContainer } from '@/server/container';
import { isAppError } from '@/server/domain/errors';
import { sessionCookieName } from '@/server/http/cookies';

export async function getSession(): Promise<AuthenticatedSession | null> {
  const container = getContainer();
  const token = (await cookies()).get(sessionCookieName(container.config))?.value;
  return container.auth.resolveSession(token);
}

/** Protects server-rendered pages: first-run → /setup, anonymous → /login. */
export async function requireSession(): Promise<AuthenticatedSession> {
  const container = getContainer();
  if (await container.auth.isSetupRequired()) redirect('/setup');
  const session = await getSession();
  if (!session) redirect('/login');
  return session;
}

/** Maps domain NotFoundError to the Next.js 404 page. */
export async function orNotFound<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    if (isAppError(error) && error.status === 404) notFound();
    throw error;
  }
}
