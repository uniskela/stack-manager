import type { z } from 'zod';
import { defineRoute } from '@/server/http/route';
import { RepositoryTestSchema } from '@/server/http/schemas';

type Params = { workspaceId: string };

/** Tests access to a remote before saving. Secrets in the body are used in memory only. */
export const POST = defineRoute<Params, z.infer<typeof RepositoryTestSchema>>(
  { auth: 'user', body: RepositoryTestSchema },
  async ({ container, params, body, session }) => {
    await container.workspaces.get(params.workspaceId);
    return { result: await container.repositories.testConnection(params.workspaceId, body, session.user.id) };
  },
);
