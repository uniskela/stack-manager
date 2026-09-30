import { defineRoute } from '@/server/http/route';

export const DELETE = defineRoute({ auth: 'user' }, async ({ container, session, params }) => {
  await container.auth.revokeSession(session.user.id, params.sessionId, session.session.id);
  return { ok: true };
});
