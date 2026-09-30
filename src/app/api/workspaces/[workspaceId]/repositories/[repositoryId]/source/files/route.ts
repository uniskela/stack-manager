import { ValidationError } from '@/server/domain/errors';
import { defineRoute } from '@/server/http/route';

type Params = { workspaceId: string; repositoryId: string };

/** One file anywhere in the repository. Secret files are listed as locked and never returned. */
export const GET = defineRoute<Params>({ auth: 'user' }, async ({ container, params, req }) => {
  const path = new URL(req.url).searchParams.get('path');
  if (!path) throw new ValidationError('Invalid request.', { path: 'Required.' });
  return { file: await container.source.readFile(params.workspaceId, params.repositoryId, '', path) };
});
