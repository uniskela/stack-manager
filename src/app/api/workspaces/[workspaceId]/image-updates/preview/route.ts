import { z } from 'zod';
import { MAX_IMAGE_UPDATE_CANDIDATES } from '@/shared/image-update-planning';
import { defineRoute } from '@/server/http/route';

const request = z.strictObject({
  candidates: z
    .array(
      z.strictObject({
        stackId: z.uuid(),
        service: z
          .string()
          .min(1)
          .max(255)
          .regex(/^[A-Za-z0-9_.-]+$/),
        source: z.enum(['manual', 'wud']),
        targetTag: z.string().max(128),
        changelogUrl: z.string().trim().max(2048).optional(),
      }),
    )
    .min(1)
    .max(MAX_IMAGE_UPDATE_CANDIDATES),
});

export const POST = defineRoute<{ workspaceId: string }, z.infer<typeof request>>(
  { auth: 'user', body: request },
  async ({ params, container, body, session }) =>
    container.imageUpdateStaging.preview(params.workspaceId, session.user.id, body.candidates),
);
