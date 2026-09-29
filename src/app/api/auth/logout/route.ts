import { clearSessionCookie } from '@/server/http/cookies';
import { defineRoute, json } from '@/server/http/route';

/** Public so a stale cookie can always be cleared; the server-side session row is deleted if present. */
export const POST = defineRoute({ auth: 'public' }, async ({ container, sessionToken, session }) => {
  await container.auth.logout(sessionToken, session?.user.id ?? null);
  return json({ ok: true }, { headers: { 'Set-Cookie': clearSessionCookie(container.config) } });
});
