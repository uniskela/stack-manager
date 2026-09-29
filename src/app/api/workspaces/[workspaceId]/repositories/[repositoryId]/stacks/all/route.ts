import { defineRoute } from '@/server/http/route';

type Params = { workspaceId: string; repositoryId: string };

/** Registers every Compose folder of the fetched commit that is not a stack yet. */
export const POST = defineRoute<Params>({ auth: 'user' }, async ({ container, params, session }) => ({
  result: await container.stacks.addAll(params.workspaceId, params.repositoryId, session.user.id),
}));
