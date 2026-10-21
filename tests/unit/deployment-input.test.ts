import { describe, expect, it } from 'vitest';
import { DeploymentBindingSchema } from '@/server/http/schemas';

describe('deployment configuration HTTP boundary', () => {
  const valid = {
    providerType: 'generic-webhook',
    enabled: true,
    expectedRevision: null,
    configuration: { url: 'https://hooks.example/deploy', bearerToken: 'synthetic' },
  };
  it('accepts explicit manual-only configuration', () => {
    expect(DeploymentBindingSchema.safeParse(valid).success).toBe(true);
    expect(
      DeploymentBindingSchema.safeParse({
        providerType: 'portainer-webhook',
        enabled: false,
        expectedRevision: 'revision',
      }).success,
    ).toBe(true);
  });
  it('rejects unknown fields, automatic deployment and conflicting credential sources', () => {
    for (const input of [
      { ...valid, deployOnPush: true },
      { ...valid, headers: {} },
      { ...valid, configuration: { ...valid.configuration, headers: {} } },
      { ...valid, credentialId: 'credential' },
      { ...valid, providerType: 'other' },
      { ...valid, expectedRevision: undefined },
    ]) {
      expect(DeploymentBindingSchema.safeParse(input).success).toBe(false);
    }
  });
});
