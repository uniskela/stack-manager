import { defineRoute } from '@/server/http/route';

type Params = { workspaceId: string; stackId: string };

/** Files under the stack folder at the fetched commit, plus new files that exist only as drafts. */
export const GET = defineRoute<Params>({ auth: 'user' }, async ({ container, params }) => {
  const stack = await container.stacks.get(params.workspaceId, params.stackId);
  return container.source.tree(params.workspaceId, stack.repository.id, stack.rootPath);
});
