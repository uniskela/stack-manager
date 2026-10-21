import { z } from 'zod';
import { defineRoute } from '@/server/http/route';
import { DeploymentBindingSchema } from '@/server/http/schemas';

type Params = { workspaceId: string; stackId: string };
export const GET = defineRoute<Params>({ auth: 'user' }, async ({ container, params }) =>
  container.deployments.settings(params.workspaceId, params.stackId),
);
export const PUT = defineRoute<Params, z.infer<typeof DeploymentBindingSchema>>(
  { auth: 'user', body: DeploymentBindingSchema },
  async ({ container, params, body, session }) =>
    container.deployments.configure(params.workspaceId, params.stackId, body, session.user.id),
);
const Removal = z.object({ expectedRevision: z.string().min(1).max(128) }).strict();
export const DELETE = defineRoute<Params, z.infer<typeof Removal>>(
  { auth: 'user', body: Removal },
  async ({ container, params, body, session }) => {
    await container.deployments.remove(
      params.workspaceId,
      params.stackId,
      session.user.id,
      body.expectedRevision,
    );
    return { binding: null };
  },
);
