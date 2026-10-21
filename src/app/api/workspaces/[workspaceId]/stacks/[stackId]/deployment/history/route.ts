import { defineRoute } from '@/server/http/route';

type Params = { workspaceId: string; stackId: string };
export const GET = defineRoute<Params>({ auth: 'user' }, async ({ container, params }) =>
  container.deployments.history(params.workspaceId, params.stackId),
);
