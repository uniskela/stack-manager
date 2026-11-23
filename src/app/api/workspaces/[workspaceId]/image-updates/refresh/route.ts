import { defineRoute, json } from '@/server/http/route';

export const POST = defineRoute<{ workspaceId: string }>({ auth: 'user' }, async ({ container, params }) => {
  const result = await container.imageUpdates.requestRefresh(params.workspaceId);
  container.worker.nudge();
  return json(result, { status: 202 });
});
