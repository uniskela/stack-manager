import type { z } from 'zod';
import { defineRoute } from '@/server/http/route';
import { RepositoryPatchSchema } from '@/server/http/schemas';

type Params = { workspaceId: string; repositoryId: string };

export const GET = defineRoute<Params>({ auth: 'user' }, async ({ container, params }) => ({
  repository: await container.repositories.get(params.workspaceId, params.repositoryId),
  branches: await container.repositories.branches(params.workspaceId, params.repositoryId),
}));

export const PATCH = defineRoute<Params, z.infer<typeof RepositoryPatchSchema>>(
  { auth: 'user', body: RepositoryPatchSchema },
  async ({ container, params, body, session }) => {
    const repository = await container.repositories.update(
      params.workspaceId,
      params.repositoryId,
      body,
      session.user.id,
    );
    container.worker.nudge();
    return { repository };
  },
);

/** Removes the connection and its local clone. Linked credentials are kept (they may be reused). */
export const DELETE = defineRoute<Params>({ auth: 'user' }, async ({ container, params, session }) => {
  await container.repositories.delete(params.workspaceId, params.repositoryId, session.user.id);
  return { ok: true };
});
