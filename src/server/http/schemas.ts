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
});

export const RepositoryPatchSchema = z
  .object({ name: z.string().max(200).optional(), defaultBranch: z.string().max(255).optional() })
  .strict();
