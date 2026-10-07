import { defineRoute } from '@/server/http/route';

type Params = { workspaceId: string; repositoryId: string; sha: string };

export const GET = defineRoute<Params>({ auth: 'user' }, async ({ container, params }) =>
  container.gitHistory.detail(params.workspaceId, params.repositoryId, '', params.sha),
);
