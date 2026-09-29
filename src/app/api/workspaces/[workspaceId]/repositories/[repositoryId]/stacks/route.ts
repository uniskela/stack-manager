import type { z } from 'zod';
import { defineRoute, json } from '@/server/http/route';
import { StackCreateSchema } from '@/server/http/schemas';

type Params = { workspaceId: string; repositoryId: string };

/** Stacks registered for this repository plus discovery suggestions from the fetched commit. */
export const GET = defineRoute<Params>({ auth: 'user' }, async ({ container, params }) => ({
  stacks: await container.stacks.listForRepository(params.workspaceId, params.repositoryId),
  suggestions: await container.stacks.suggest(params.workspaceId, params.repositoryId),
}));

export const POST = defineRoute<Params, z.infer<typeof StackCreateSchema>>(
  { auth: 'user', body: StackCreateSchema },
  async ({ container, params, body, session }) =>
    json(
      {
        stack: await container.stacks.create(params.workspaceId, params.repositoryId, body, session.user.id),
      },
      { status: 201 },
    ),
);
