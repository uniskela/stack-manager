import type { z } from 'zod';
import { ValidationError } from '@/server/domain/errors';
import { defineRoute } from '@/server/http/route';
import { DRAFT_BODY_LIMIT, DraftSaveSchema } from '@/server/http/schemas';

type Params = { workspaceId: string; stackId: string };

/** Drafts under the stack folder with their base content, for review. */
export const GET = defineRoute<Params>({ auth: 'user' }, async ({ container, params }) => {
  const stack = await container.stacks.get(params.workspaceId, params.stackId);
  return { changes: await container.source.changes(params.workspaceId, stack.repository.id, stack.rootPath) };
});

/** Saves (or clears, when identical to the commit) the draft for one file. */
export const PUT = defineRoute<Params, z.infer<typeof DraftSaveSchema>>(
  { auth: 'user', body: DraftSaveSchema, maxBodyBytes: DRAFT_BODY_LIMIT },
  async ({ container, params, body, session }) => {
    const stack = await container.stacks.get(params.workspaceId, params.stackId);
    return {
      file: await container.source.saveDraft(
        params.workspaceId,
        stack.repository.id,
        stack.rootPath,
        body,
        session.user.id,
      ),
    };
  },
);

export const DELETE = defineRoute<Params>({ auth: 'user' }, async ({ container, params, req, session }) => {
  const path = new URL(req.url).searchParams.get('path');
  if (!path) throw new ValidationError('Invalid request.', { path: 'Required.' });
  const stack = await container.stacks.get(params.workspaceId, params.stackId);
  return {
    file: await container.source.discardDraft(
      params.workspaceId,
      stack.repository.id,
      stack.rootPath,
      path,
      session.user.id,
    ),
  };
});
