import { z } from 'zod';
import { CREDENTIAL_KINDS } from '@/server/domain/credential';
import { defineRoute, json } from '@/server/http/route';

type Params = { workspaceId: string };

/** GET returns masked metadata only — never ciphertext or plaintext. */
export const GET = defineRoute<Params>({ auth: 'user' }, async ({ container, params }) => {
  await container.workspaces.get(params.workspaceId);
  return { credentials: await container.credentials.list(params.workspaceId) };
});

const CreateBody = z.object({
  kind: z.enum(CREDENTIAL_KINDS),
  providerType: z.string().max(64),
  label: z.string().max(200),
  secret: z.string().max(16 * 1024),
  meta: z.record(z.string(), z.string().max(500)).optional(),
});

/** Accepts the secret once; the response carries id, label and a masked hint only. */
export const POST = defineRoute<Params, z.infer<typeof CreateBody>>(
  { auth: 'user', body: CreateBody },
  async ({ container, params, body, session }) => {
    await container.workspaces.get(params.workspaceId);
    const credential = await container.credentials.create(
      { ...body, workspaceId: params.workspaceId },
      session.user.id,
    );
    return json({ credential }, { status: 201 });
  },
);
