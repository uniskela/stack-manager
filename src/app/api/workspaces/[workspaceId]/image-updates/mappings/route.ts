import { z } from 'zod';
import { MAX_WUD_MAPPINGS_PER_SAVE } from '@/shared/image-updates';
import { ValidationError } from '@/server/domain/errors';
import { defineRoute } from '@/server/http/route';
import { WUD_IDENTIFIER } from '@/server/providers/wud/client';

type Params = { workspaceId: string };

const request = z
  .strictObject({
    confirmChoice: z.literal(true).optional(),
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
  })
  .refine(({ confirmChoice, mappings }) => !confirmChoice || mappings.length === 1, {
    message: 'Confirm one WUD project at a time.',
  });

export const GET = defineRoute<Params>({ auth: 'user' }, async ({ container, params, req }) => {
  const stackId = new URL(req.url).searchParams.get('stackId');
  if (stackId !== null && !z.uuid().safeParse(stackId).success)
    throw new ValidationError('Invalid stack ID.');
  return container.imageUpdates.discoverMappings(params.workspaceId, stackId ?? undefined);
});

export const POST = defineRoute<Params, z.infer<typeof request>>(
  { auth: 'user', body: request },
  async ({ container, params, body, session }) =>
    container.imageUpdates.saveDiscoveredMappings(
      params.workspaceId,
      body.mappings,
      session.user.id,
      body.confirmChoice,
    ),
);
