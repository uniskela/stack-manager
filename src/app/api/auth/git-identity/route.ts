import { z } from 'zod';
import { defineRoute } from '@/server/http/route';

const GitIdentityBody = z.object({
  name: z.string().max(1024),
  email: z.string().max(1024),
});

export const GET = defineRoute({ auth: 'user' }, async ({ container, session }) => ({
  identity: await container.auth.getGitIdentity(session.user.id),
}));

export const PUT = defineRoute(
  { auth: 'user', body: GitIdentityBody },
  async ({ container, body, session }) => ({
    identity: await container.auth.updateGitIdentity(session.user.id, body),
  }),
);
