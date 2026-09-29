import { defineRoute } from '@/server/http/route';

type Params = { workspaceId: string; repositoryId: string };

/** Queues a clone/fetch job (deduplicated while one is pending or running). */
export const POST = defineRoute<Params>({ auth: 'user' }, async ({ container, params, session }) => {
  const repository = await container.repositories.requestSync(
    params.workspaceId,
    params.repositoryId,
    session.user.id,
  );
  container.worker.nudge();
  return { repository };
});
