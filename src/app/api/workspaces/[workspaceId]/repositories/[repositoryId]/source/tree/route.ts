import { defineRoute } from '@/server/http/route';

type Params = { workspaceId: string; repositoryId: string };

/**
 * Every file of the repository at the fetched commit, plus new files that exist only as drafts, for
 * editing files outside any stack (root README, docs/, shared .env.example).
 */
export const GET = defineRoute<Params>({ auth: 'user' }, async ({ container, params }) =>
  container.source.tree(params.workspaceId, params.repositoryId, ''),
);
