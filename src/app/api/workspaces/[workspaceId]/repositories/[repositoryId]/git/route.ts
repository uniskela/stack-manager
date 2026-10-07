import { gitWorkflowResponse } from '@/server/http/git-workflow';
import { defineRoute } from '@/server/http/route';

export const GET = defineRoute<{ workspaceId: string; repositoryId: string }>(
  { auth: 'user' },
  async ({ container, params, session }) =>
    gitWorkflowResponse(
      await container.gitWorkflow.inspect(params.workspaceId, params.repositoryId, session.user.id),
    ),
);
