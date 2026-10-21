import { z } from 'zod';
import { defineRoute } from '@/server/http/route';

type Params = { workspaceId: string; repositoryId: string };
const Body = z
  .object({ secret: z.string().max(16384).optional(), credentialId: z.string().uuid().optional() })
  .strict()
  .refine(
    (value) => Number(value.secret !== undefined) + Number(value.credentialId !== undefined) === 1,
    'Supply exactly one signing secret or credential.',
  );

export const GET = defineRoute<Params>({ auth: 'user' }, async ({ container, params }) =>
  container.gitWebhooks.settings(params.workspaceId, params.repositoryId),
);
export const PUT = defineRoute<Params, z.infer<typeof Body>>(
  { auth: 'user', body: Body },
  async ({ container, params, body, session }) =>
    container.gitWebhooks.configure(params.workspaceId, params.repositoryId, body, session.user.id),
);
export const DELETE = defineRoute<Params>({ auth: 'user' }, async ({ container, params, session }) =>
  container.gitWebhooks.disable(params.workspaceId, params.repositoryId, session.user.id),
);
