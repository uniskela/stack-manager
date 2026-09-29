import type { z } from 'zod';
import { ValidationError } from '@/server/domain/errors';
import { defineRoute } from '@/server/http/route';
import { DRAFT_BODY_LIMIT, DraftSaveSchema } from '@/server/http/schemas';

type Params = { workspaceId: string; repositoryId: string };

/** Every draft in the repository (stack folders included) with its base content, for review. */
export const GET = defineRoute<Params>({ auth: 'user' }, async ({ container, params }) => ({
  changes: await container.source.changes(params.workspaceId, params.repositoryId, ''),
}));

/** Saves (or clears, when identical to the commit) the draft for one file anywhere in the repository. */
export const PUT = defineRoute<Params, z.infer<typeof DraftSaveSchema>>(
  { auth: 'user', body: DraftSaveSchema, maxBodyBytes: DRAFT_BODY_LIMIT },
  async ({ container, params, body, session }) => ({
    file: await container.source.saveDraft(
      params.workspaceId,
      params.repositoryId,
      '',
      body,
      session.user.id,
    ),
  }),
);

export const DELETE = defineRoute<Params>({ auth: 'user' }, async ({ container, params, req, session }) => {
  const path = new URL(req.url).searchParams.get('path');
  if (!path) throw new ValidationError('Invalid request.', { path: 'Required.' });
  return {
    file: await container.source.discardDraft(
      params.workspaceId,
      params.repositoryId,
      '',
      path,
      session.user.id,
    ),
  };
});
