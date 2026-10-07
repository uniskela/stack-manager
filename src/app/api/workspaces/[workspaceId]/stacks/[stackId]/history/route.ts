import { historyQuery } from '@/server/http/git-history';
import { defineRoute } from '@/server/http/route';

type Params = { workspaceId: string; stackId: string };

export const GET = defineRoute<Params>({ auth: 'user' }, async ({ container, params, req }) => {
  const stack = await container.stacks.get(params.workspaceId, params.stackId);
  return container.gitHistory.list(
    params.workspaceId,
    stack.repository.id,
    stack.rootPath,
    historyQuery(req),
  );
});
