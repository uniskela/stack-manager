import { z } from 'zod';
import { defineRoute } from '@/server/http/route';

type Params = { workspaceId: string; credentialId: string };

/** Replace-only secret update. The response never echoes the new or old value. */
export const PUT = defineRoute<Params, { secret: string }>(
  { auth: 'user', body: z.object({ secret: z.string().max(16 * 1024) }).strict() },
  async ({ container, params, body, session }) => ({
    credential: await container.credentials.replaceSecret(
      params.workspaceId,
      params.credentialId,
      body.secret,
      session.user.id,
    ),
  }),
);
