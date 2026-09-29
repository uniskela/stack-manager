import { ValidationError } from '@/server/domain/errors';
import { defineRoute } from '@/server/http/route';

type Params = { workspaceId: string; stackId: string };

/** One file (committed content + draft). Secret files are listed as locked and never returned. */
export const GET = defineRoute<Params>({ auth: 'user' }, async ({ container, params, req }) => {
  const path = new URL(req.url).searchParams.get('path');
  if (!path) throw new ValidationError('Invalid request.', { path: 'Required.' });
  const stack = await container.stacks.get(params.workspaceId, params.stackId);
  return {
    file: await container.source.readFile(params.workspaceId, stack.repository.id, stack.rootPath, path),
  };
});
