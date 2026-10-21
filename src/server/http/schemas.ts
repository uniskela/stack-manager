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
    autoFetchEnabled: z.boolean().optional(),
    autoFetchIntervalMinutes: z.number().int().min(5).max(1440).nullable().optional(),
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

export const GitCommitSchema = z
  .object({
    paths: z.array(z.string().min(1).max(1024)).min(1).max(100),
    message: z.string().min(1).max(8192),
    push: z.boolean().optional(),
    acknowledgeWarnings: z.boolean().optional(),
  })
  .strict();

const objectId = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/);
export const GitPushSchema = z.object({ commitSha: objectId, expectedRemoteSha: objectId }).strict();

export const RoutingPolicySchema = z
  .object({
    include: z.array(z.string().min(1).max(256)).max(32),
    exclude: z.array(z.string().min(1).max(256)).max(32),
    dependencies: z.array(z.string().min(1).max(256)).max(32),
  })
  .strict();
export const RoutingPreviewSchema = z
  .object({ routingPolicy: RoutingPolicySchema, paths: z.array(z.string().min(1).max(1024)).max(10000) })
  .strict();

export const DeploymentBindingSchema = z
  .object({
    providerType: z.enum(['portainer-webhook', 'generic-webhook']),
    enabled: z.boolean(),
    deployOnPush: z.boolean().optional(),
    routingPolicy: RoutingPolicySchema.optional(),
    expectedRevision: z.string().min(1).max(128).nullable(),
    configuration: z
      .object({ url: z.string().min(1).max(4096), bearerToken: z.string().min(1).max(16384).optional() })
      .strict()
      .optional(),
    credentialId: z.string().min(1).max(64).optional(),
  })
  .strict()
  .refine(
    (input) => !(input.configuration && input.credentialId),
    'Supply configuration or a credential, not both.',
  )
  .refine(
    (input) => input.providerType !== 'portainer-webhook' || !input.configuration?.bearerToken,
    'Portainer uses its webhook URL for authentication.',
  );
