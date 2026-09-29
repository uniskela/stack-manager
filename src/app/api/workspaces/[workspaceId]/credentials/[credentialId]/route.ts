import { z } from 'zod';
import { defineRoute } from '@/server/http/route';

type Params = { workspaceId: string; credentialId: string };

export const GET = defineRoute<Params>({ auth: 'user' }, async ({ container, params }) => ({
  credential: await container.credentials.get(params.workspaceId, params.credentialId),
}));

const PatchBody = z
  .object({
    label: z.string().max(200).optional(),
    meta: z.record(z.string(), z.string().max(500)).optional(),
  })
  .strict();

/** Updates non-secret details. Secrets are replaced only via PUT …/secret. */
export const PATCH = defineRoute<Params, z.infer<typeof PatchBody>>(
  { auth: 'user', body: PatchBody },
  async ({ container, params, body, session }) => ({
    credential: await container.credentials.update(
      params.workspaceId,
      params.credentialId,
      body,
      session.user.id,
    ),
  }),
);

export const DELETE = defineRoute<Params>({ auth: 'user' }, async ({ container, params, session }) => {
  await container.credentials.delete(params.workspaceId, params.credentialId, session.user.id);
  return { ok: true };
});
