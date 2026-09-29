import type { z } from 'zod';
import { defineRoute } from '@/server/http/route';
import { StackPatchSchema } from '@/server/http/schemas';

type Params = { workspaceId: string; stackId: string };

export const GET = defineRoute<Params>({ auth: 'user' }, async ({ container, params }) => ({
  stack: await container.stacks.get(params.workspaceId, params.stackId),
}));

export const PATCH = defineRoute<Params, z.infer<typeof StackPatchSchema>>(
  { auth: 'user', body: StackPatchSchema },
  async ({ container, params, body, session }) => ({
    stack: await container.stacks.update(params.workspaceId, params.stackId, body, session.user.id),
  }),
);

/** Removes the stack record only; repository files and drafts are untouched. */
export const DELETE = defineRoute<Params>({ auth: 'user' }, async ({ container, params, session }) => {
  await container.stacks.delete(params.workspaceId, params.stackId, session.user.id);
  return { ok: true };
});
