import { z } from 'zod';
import { ForbiddenError } from '@/server/domain/errors';
import { defineRoute } from '@/server/http/route';

type Params = { workspaceId: string };
const request = z.strictObject({
  action: z.enum(['merge', 'rebase']).optional(),
  repositoryId: z.uuid(),
  number: z.number().int().positive(),
  headSha: z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/),
});

export const GET = defineRoute<Params>({ auth: 'user' }, async ({ params, container, req, session }) => {
  if (session.user.role !== 'admin') throw new ForbiddenError();
  return container.wudImageUpdateReview.list(params.workspaceId, req.signal);
});

export const POST = defineRoute<Params, z.infer<typeof request>>(
  { auth: 'user', body: request },
  async ({ params, container, body, req, session }) => {
    if (session.user.role !== 'admin') throw new ForbiddenError();
    return container.wudImageUpdateReview.update(params.workspaceId, session.user.id, body, req.signal);
  },
);
