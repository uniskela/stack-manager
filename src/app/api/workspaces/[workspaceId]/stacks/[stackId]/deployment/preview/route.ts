import { z } from 'zod';
import { defineRoute } from '@/server/http/route';
import { RoutingPreviewSchema } from '@/server/http/schemas';

type Params = { workspaceId: string; stackId: string };
export const POST = defineRoute<Params, z.infer<typeof RoutingPreviewSchema>>(
  { auth: 'user', body: RoutingPreviewSchema, maxBodyBytes: 12 * 1024 * 1024 },
  async ({ container, params, body }) =>
    container.deployments.preview(params.workspaceId, params.stackId, body),
);
