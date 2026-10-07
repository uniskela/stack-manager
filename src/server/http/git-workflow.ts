import type { GitWorkflowResult } from '@/shared/git-workflow';
import { json } from './route';

export function gitWorkflowResponse(result: GitWorkflowResult) {
  const status = ['ready', 'commit_succeeded', 'push_succeeded'].includes(result.status)
    ? 200
    : ['validation_blocked', 'warnings_unacknowledged'].includes(result.status)
      ? 422
      : result.status === 'git_operation_failed'
        ? 502
        : 409;
  return json(result, { status });
}
