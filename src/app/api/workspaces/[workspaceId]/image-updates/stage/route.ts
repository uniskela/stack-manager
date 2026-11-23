import { z } from 'zod';
import { MAX_IMAGE_UPDATE_CANDIDATES } from '@/shared/image-update-planning';
import { defineRoute } from '@/server/http/route';

const request = z.strictObject({
  files: z
    .array(
      z.strictObject({
        token: z.string().min(1).max(24_576),
        acknowledgeReview: z.boolean(),
      }),
    )
    .min(1)
    .max(MAX_IMAGE_UPDATE_CANDIDATES),
});

export const POST = defineRoute<{ workspaceId: string }, z.infer<typeof request>>(
  { auth: 'user', body: request },
  async ({ params, container, body, session }) =>
    container.imageUpdateStaging.stage(params.workspaceId, session.user.id, body.files),
);
