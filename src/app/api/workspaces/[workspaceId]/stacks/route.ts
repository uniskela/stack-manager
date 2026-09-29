import { defineRoute } from '@/server/http/route';

type Params = { workspaceId: string };

export const GET = defineRoute<Params>({ auth: 'user' }, async ({ container, params }) => {
  await container.workspaces.get(params.workspaceId);
  return { stacks: await container.stacks.list(params.workspaceId) };
});
