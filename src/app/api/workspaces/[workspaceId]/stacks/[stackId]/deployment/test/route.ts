import { z } from 'zod';
import { defineRoute } from '@/server/http/route';

type Params = { workspaceId: string; stackId: string };
export const POST = defineRoute<Params, Record<string, never>>(
  { auth: 'user', body: z.object({}).strict() },
  async ({ container, params, session }) =>
    container.deployments.test(params.workspaceId, params.stackId, session.user.id),
);
