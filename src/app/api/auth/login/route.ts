import { z } from 'zod';
import { serializeSessionCookie } from '@/server/http/cookies';
import { defineRoute, json } from '@/server/http/route';

const LoginBody = z.object({ username: z.string().max(64), password: z.string().max(1024) });

export const POST = defineRoute(
  { auth: 'public', body: LoginBody },
  async ({ container, body, requestContext }) => {
    const { user, token, expiresAt } = await container.auth.login(body, requestContext);
    return json(
      { user: { id: user.id, username: user.username, role: user.role } },
      { headers: { 'Set-Cookie': serializeSessionCookie(container.config, token, expiresAt) } },
    );
  },
);
