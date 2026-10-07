import { defineRoute } from '@/server/http/route';

type Params = { workspaceId: string; stackId: string; sha: string };

export const GET = defineRoute<Params>({ auth: 'user' }, async ({ container, params }) => {
  const stack = await container.stacks.get(params.workspaceId, params.stackId);
  return container.gitHistory.detail(params.workspaceId, stack.repository.id, stack.rootPath, params.sha);
});
