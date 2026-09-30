import { defineRoute } from '@/server/http/route';

type Params = { sessionId: string };

export const DELETE = defineRoute<Params>({ auth: 'user' }, async ({ container, session, params }) => {
  await container.auth.revokeSession(session.user.id, params.sessionId, session.session.id);
  return { ok: true };
});
