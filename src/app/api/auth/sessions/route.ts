import { defineRoute } from '@/server/http/route';

export const GET = defineRoute({ auth: 'user' }, async ({ container, session }) => ({
  sessions: await container.auth.listSessions(session.user.id, session.session.id),
}));

export const DELETE = defineRoute({ auth: 'user' }, async ({ container, session }) => ({
  revoked: await container.auth.revokeOtherSessions(session.user.id, session.session.id),
}));
