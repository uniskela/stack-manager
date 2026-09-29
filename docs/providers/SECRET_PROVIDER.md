# SecretProvider abstraction

## Purpose

Integrate external secret managers for **references and metadata**, not to become a vault UI that dumps secret values into the browser.

## Capability interface (logical)

```ts
interface SecretProvider {
  readonly type: string;
  readonly capabilities: {
    testConnection: boolean;
    listPaths: boolean;
    listKeysMetadata: boolean; // names only
    checkKeyExists: boolean;
    // readSecretValue: optional, default OFF, never required for MVP inventory
  };

  testConnection(cred: ResolvedCredential, cfg: SecretConfig): Promise<Result>;
  listKeysMetadata?(binding: SecretBinding): Promise<SecretKeyMeta[]>;
  keyExists?(binding: SecretBinding, key: string): Promise<boolean>;
}
```

`SecretKeyMeta`: key name, version/updatedAt if available — **no values**.

## Infisical (initial)

Binding config example:

- project
- environment
- path (e.g. `/122-liftlog`)

Use service token / machine identity stored encrypted.

## Future

- HashiCorp Vault
- OpenBao
- Bitwarden Secrets Manager
- Doppler, etc.

## Application behaviours (PR #6)

- Parse Compose and `.env.example` for variable references
- Inventory: missing / unused / defaulted variables (against example + secret metadata)
- Warn when Compose references keys not found in bound secret path
- Do not display secret values by default; any future “reveal” requires explicit capability + audit

## Non-goals

- Storing production secrets inside stack-manager DB as the system of record
- Committing secrets to Git
- Syncing runtime env from Portainer back into Git
