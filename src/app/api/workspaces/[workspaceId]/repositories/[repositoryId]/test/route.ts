import { defineRoute } from '@/server/http/route';

type Params = { workspaceId: string; repositoryId: string };

/** Server-side connection test using the stored credential, decrypted in memory only. */
export const POST = defineRoute<Params>({ auth: 'user' }, async ({ container, params, session }) => ({
  result: await container.repositories.testSaved(params.workspaceId, params.repositoryId, session.user.id),
}));
