import { defineRoute } from '@/server/http/route';

export const GET = defineRoute({ auth: 'user' }, async ({ session }) => ({
  user: { id: session.user.id, username: session.user.username, role: session.user.role },
  expiresAt: session.session.expiresAt.toISOString(),
}));
