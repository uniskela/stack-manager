import { historyQuery } from '@/server/http/git-history';
import { defineRoute } from '@/server/http/route';

type Params = { workspaceId: string; repositoryId: string };

export const GET = defineRoute<Params>({ auth: 'user' }, async ({ container, params, req }) =>
  container.gitHistory.list(params.workspaceId, params.repositoryId, '', historyQuery(req)),
);
