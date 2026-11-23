import { z } from 'zod';
import { defineRoute } from '@/server/http/route';

type Params = { workspaceId: string };
const revision = z.string().uuid();
const connection = z
  .object({
    baseUrl: z.string().trim().min(1).max(2048),
    token: z.string().min(1).max(4096),
    expectedRevision: revision.nullable(),
  })
  .strict();
const removal = z.object({ expectedRevision: revision }).strict();

export const GET = defineRoute<Params>({ auth: 'user' }, async ({ container, params }) =>
  container.imageUpdates.settings(params.workspaceId),
);

export const PUT = defineRoute<Params, z.infer<typeof connection>>(
  { auth: 'user', body: connection },
  async ({ container, params, body, session }) => ({
    connection: await container.imageUpdates.configure(params.workspaceId, body, session.user.id),
  }),
);

export const DELETE = defineRoute<Params, z.infer<typeof removal>>(
  { auth: 'user', body: removal },
  async ({ container, params, body, session }) => {
    await container.imageUpdates.remove(params.workspaceId, body.expectedRevision, session.user.id);
    return { connection: null };
  },
);
