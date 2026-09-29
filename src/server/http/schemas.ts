import { z } from 'zod';

export const RepositoryAuthSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('credential'), credentialId: z.string().max(64) }),
  z.object({
    type: z.literal('token'),
    token: z.string().max(16 * 1024),
    username: z.string().max(200).optional(),
    label: z.string().max(200).optional(),
  }),
]);

export const RepositoryTestSchema = z.object({
  gitProviderType: z.string().max(64),
  remoteUrl: z.string().max(2048),
  auth: RepositoryAuthSchema,
});

export const RepositoryCreateSchema = RepositoryTestSchema.extend({
  name: z.string().max(200).optional(),
  defaultBranch: z.string().max(255).optional(),
  autoAddStacks: z.boolean().optional(),
});

export const RepositoryPatchSchema = z
  .object({
    name: z.string().max(200).optional(),
    defaultBranch: z.string().max(255).optional(),
    autoAddStacks: z.boolean().optional(),
  })
  .strict();

export const StackCreateSchema = z
  .object({
    name: z.string().max(200).optional(),
    rootPath: z.string().max(1024),
    composePath: z.string().max(1024).optional(),
  })
  .strict();

export const StackPatchSchema = z
  .object({ name: z.string().max(200).optional(), composePath: z.string().max(1024).optional() })
  .strict();

export const DraftSaveSchema = z
  .object({
    path: z.string().max(1024),
    /** Checked against the 1 MiB UTF-8 limit by the service; this bound only caps parsing. */
    content: z.string().max(1024 * 1024),
    baseBlobSha: z.string().max(64).nullable(),
  })
  .strict();

/** JSON escaping can roughly double text; the service enforces the real 1 MiB content limit. */
export const DRAFT_BODY_LIMIT = 3 * 1024 * 1024;
