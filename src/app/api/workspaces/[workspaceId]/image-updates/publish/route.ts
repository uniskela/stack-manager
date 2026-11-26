import { z } from 'zod';
import { defineRoute } from '@/server/http/route';

const request = z.strictObject({
  token: z.string().min(1).max(24_576),
  acknowledgeReview: z.boolean(),
});

export const POST = defineRoute<{ workspaceId: string }, z.infer<typeof request>>(
  { auth: 'user', body: request },
  async ({ params, container, body, session }) =>
    container.imageUpdateStaging.publish(params.workspaceId, session.user.id, body),
);
