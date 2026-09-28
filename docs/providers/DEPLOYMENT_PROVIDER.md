# DeploymentProvider abstraction

## Purpose

Initiate deployments only. Report HTTP/API acceptance or failure. Do **not** manage container lifecycle.

## Capability interface (logical)

```ts
interface DeploymentProvider {
  readonly type: string;
  readonly capabilities: {
    trigger: true;
    // no destroy, no exec, no mutateRuntimeConfig
  };

  testConnection?(cfg: DeploymentConfig, cred?: ResolvedCredential): Promise<Result>;
  trigger(input: TriggerDeploymentInput): Promise<TriggerDeploymentResult>;
}
```

```ts
type TriggerDeploymentInput = {
  binding: DeploymentBinding;
  gitSha: string;
  stack: Stack;
  metadata?: Record<string, string>;
  timeoutMs: number;
};

type TriggerDeploymentResult = {
  accepted: boolean;
  httpStatus?: number;
  providerReference?: string;
  message: string; // safe for UI/audit
};
```

## PortainerWebhookDeploymentProvider

**Config:**

- webhook URL
- optional deployment metadata
- stack association (via binding)

**Actions:**

- `trigger` — HTTP request to webhook
- report acceptance/failure

**Rules:**

- Do **not** require a Portainer API credential merely to trigger a configured webhook.
- Do not call Portainer stack update APIs for MVP webhook path.

## GenericWebhookDeploymentProvider

**Config:**

- URL
- method (`POST` default)
- safe headers (no secret values in plain config; reference credential for auth headers)
- authentication reference (`credentialId`)
- timeout
- expected response (status class / optional body predicate)

## Future providers (representable now)

- Komodo
- Deployment agents
- GitHub Actions / Gitea Actions workflow dispatch
- Other orchestrators

Core stack model must not require schema changes to add these — only new adapter + binding config JSON.

## Security

- Webhook URLs may contain sensitive tokens; treat as secrets when stored (encrypt) or store token in credential and URL without secret
- Redact URLs in audit (strip query tokens, userinfo)
- SSRF controls: block link-local/metadata ranges unless explicitly allowed for homelab RFC1918 (document allowlist policy)

## Non-goals

- Orchestrating multi-step deploy pipelines beyond trigger + optional watch
- Replacing the external deploy system’s own UI
