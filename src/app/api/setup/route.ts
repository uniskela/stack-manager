import { z } from 'zod';
import { serializeSessionCookie } from '@/server/http/cookies';
import { defineRoute, json } from '@/server/http/route';

export const GET = defineRoute({ auth: 'public' }, async ({ container }) => ({
  setupRequired: await container.auth.isSetupRequired(),
  setupTokenRequired: container.auth.setupTokenRequired,
}));

const SetupBody = z.object({
  username: z.string().max(64),
  password: z.string().max(1024),
  setupToken: z.string().max(512).optional(),
});

/** First-run only: creates the initial admin and signs them in. Returns 409 once setup is complete. */
export const POST = defineRoute(
  { auth: 'public', body: SetupBody },
  async ({ container, body, requestContext }) => {
    const { user, token, expiresAt } = await container.auth.setupAdmin(body, requestContext);
    return json(
      { user: { id: user.id, username: user.username, role: user.role } },
      { status: 201, headers: { 'Set-Cookie': serializeSessionCookie(container.config, token, expiresAt) } },
    );
  },
);
