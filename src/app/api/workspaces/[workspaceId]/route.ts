import { z } from 'zod';
import { defineRoute } from '@/server/http/route';

type Params = { workspaceId: string };

export const GET = defineRoute<Params>({ auth: 'user' }, async ({ container, params }) => ({
  workspace: await container.workspaces.get(params.workspaceId),
}));

export const PATCH = defineRoute<Params, { name: string }>(
  { auth: 'user', body: z.object({ name: z.string().max(200) }) },
  async ({ container, params, body, session }) => ({
    workspace: await container.workspaces.rename(params.workspaceId, body, session.user.id),
  }),
);
