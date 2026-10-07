import type { GitPushRequest } from '@/shared/git-workflow';
import { gitWorkflowResponse } from '@/server/http/git-workflow';
import { defineRoute } from '@/server/http/route';
import { GitPushSchema } from '@/server/http/schemas';

export const POST = defineRoute<{ workspaceId: string; repositoryId: string }, GitPushRequest>(
  { auth: 'user', body: GitPushSchema },
  async ({ container, params, body, session }) =>
    gitWorkflowResponse(
      await container.gitWorkflow.push(params.workspaceId, params.repositoryId, body, session.user.id),
    ),
);
