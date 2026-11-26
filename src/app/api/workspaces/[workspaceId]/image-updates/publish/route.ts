import { z } from 'zod';
import { defineRoute } from '@/server/http/route';

const request = z.strictObject({
  token: z.string().min(1).max(60_000),
  supersede: z
    .strictObject({
      number: z.number().int().positive(),
      headSha: z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/),
    })
    .optional(),
  acknowledgeReview: z.boolean(),
});

export const POST = defineRoute<{ workspaceId: string }, z.infer<typeof request>>(
  { auth: 'user', body: request },
  async ({ params, container, body, session }) =>
    container.imageUpdateStaging.publish(params.workspaceId, session.user.id, body),
);
