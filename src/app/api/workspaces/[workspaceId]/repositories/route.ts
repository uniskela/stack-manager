import type { z } from 'zod';
import { defineRoute, json } from '@/server/http/route';
import { RepositoryCreateSchema } from '@/server/http/schemas';

type Params = { workspaceId: string };

export const GET = defineRoute<Params>({ auth: 'user' }, async ({ container, params }) => {
  await container.workspaces.get(params.workspaceId);
  return { repositories: await container.repositories.list(params.workspaceId) };
});

/** Validates, tests access, stores the connection (and token as an encrypted credential), then queues the clone. */
export const POST = defineRoute<Params, z.infer<typeof RepositoryCreateSchema>>(
  { auth: 'user', body: RepositoryCreateSchema },
  async ({ container, params, body, session }) => {
    await container.workspaces.get(params.workspaceId);
    const repository = await container.repositories.create(params.workspaceId, body, session.user.id);
    container.worker.nudge();
    return json({ repository }, { status: 201 });
  },
);
