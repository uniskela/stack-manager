import { z } from 'zod';
import { defineRoute, json } from '@/server/http/route';

export const GET = defineRoute({ auth: 'user' }, async ({ container }) => ({
  workspaces: await container.workspaces.list(),
}));

export const POST = defineRoute(
  { auth: 'user', body: z.object({ name: z.string().max(200) }) },
  async ({ container, body, session }) =>
    json({ workspace: await container.workspaces.create(body, session.user.id) }, { status: 201 }),
);
