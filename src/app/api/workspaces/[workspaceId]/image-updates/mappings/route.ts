import { z } from 'zod';
import { MAX_WUD_MAPPINGS_PER_SAVE } from '@/shared/image-updates';
import { defineRoute } from '@/server/http/route';
import { WUD_IDENTIFIER } from '@/server/providers/wud/client';

type Params = { workspaceId: string };

const request = z.strictObject({
  mappings: z
    .array(
      z.strictObject({
        stackId: z.uuid(),
        watcher: z.string().regex(WUD_IDENTIFIER),
        project: z.string().regex(WUD_IDENTIFIER),
      }),
    )
    .min(1)
    .max(MAX_WUD_MAPPINGS_PER_SAVE)
    .refine((items) => new Set(items.map(({ stackId }) => stackId)).size === items.length, {
      message: 'Select one WUD project per stack.',
    }),
});

export const GET = defineRoute<Params>({ auth: 'user' }, async ({ container, params }) =>
  container.imageUpdates.discoverMappings(params.workspaceId),
);

export const POST = defineRoute<Params, z.infer<typeof request>>(
  { auth: 'user', body: request },
  async ({ container, params, body, session }) =>
    container.imageUpdates.saveDiscoveredMappings(params.workspaceId, body.mappings, session.user.id),
);
