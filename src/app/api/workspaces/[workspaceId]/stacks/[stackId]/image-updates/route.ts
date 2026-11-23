import { z } from 'zod';
import { defineRoute } from '@/server/http/route';

type Params = { workspaceId: string; stackId: string };
const binding = z
  .object({
    watcher: z.string().trim().min(1).max(128),
    project: z.string().trim().min(1).max(128),
  })
  .strict();

export const GET = defineRoute<Params>({ auth: 'user' }, async ({ container, params }) =>
  container.imageUpdates.stack(params.workspaceId, params.stackId),
);

export const PUT = defineRoute<Params, z.infer<typeof binding>>(
  { auth: 'user', body: binding },
  async ({ container, params, session, body }) => {
    await container.imageUpdates.setBinding(params.workspaceId, params.stackId, body, session.user.id);
    return { binding: body };
  },
);

export const DELETE = defineRoute<Params>({ auth: 'user' }, async ({ container, params, session }) => {
  await container.imageUpdates.setBinding(params.workspaceId, params.stackId, null, session.user.id);
  return { binding: null };
});
