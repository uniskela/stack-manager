import type { GitCommitRequest } from '@/shared/git-workflow';
import { gitWorkflowResponse } from '@/server/http/git-workflow';
import { defineRoute } from '@/server/http/route';
import { GitCommitSchema } from '@/server/http/schemas';

export const POST = defineRoute<{ workspaceId: string; repositoryId: string }, GitCommitRequest>(
  { auth: 'user', body: GitCommitSchema },
  async ({ container, params, body, session }) =>
    gitWorkflowResponse(
      await container.gitWorkflow.commit(params.workspaceId, params.repositoryId, body, session.user.id),
    ),
);
