# RuntimeProvider abstraction

## Purpose

Optional, **read-only** context about what is currently running. Never authoritative for configuration. Never expose destructive Docker controls through this application.

## Capability interface (logical)

```ts
interface RuntimeProvider {
  readonly type: string;
  readonly capabilities: RuntimeCapabilities;
}

type RuntimeCapabilities = {
  testConnection: boolean;
  listEnvironments: boolean;
  resolveStack: boolean;
  getStackRuntimeState: boolean;
  getContainerSummaries: boolean;
  getRecentLogs: boolean;
  deepLinkToStack: boolean;
  // Explicitly absent in MVP: mutate, exec, delete, prune, restartArbitrary
};
```

```ts
interface ReadOnlyRuntimeProvider extends RuntimeProvider {
  testConnection(cred: ResolvedCredential, cfg: RuntimeConfig): Promise<Result>;
  listEnvironments?(...): Promise<EnvironmentSummary[]>;
  identifyStack(...): Promise<StackIdentity | null>;
  getRuntimeSnapshot(...): Promise<RuntimeSnapshot>;
  getRecentLogs?(..., opts: LogOpts): Promise<LogChunk>;
  getDeepLink?(...): Promise<string | null>;
}
```

### RuntimeSnapshot (illustrative)

- stack/container runtime state
- image currently running
- container start time
- health state
- restart count (where available)
- container status
- selected deployment/runtime metadata useful for validation
- timestamp

## PortainerRuntimeProvider

Authenticate with Portainer API access token.

**Allowed application behaviours:**

- test connection
- enumerate permitted environments
- identify configured stack
- obtain stack/container runtime state
- image, start time, health, restart count, status
- selected recent logs
- metadata useful for validation / drift warnings
- “Open in Portainer” deep-link

**Must not implement (even if token allows):**

- delete container
- remove volume
- prune images
- arbitrary Docker exec
- restart arbitrary container
- delete network
- change runtime configuration

Adapter code should only call the minimal Portainer API surface required. Prefer allowlisted endpoints in one module.

## No runtime provider

Fully valid. UI omits runtime header details / watch observation steps that require runtime, while still allowing Git edit + deploy webhook.

## Drift warnings (informational)

While editing, runtime may warn:

- current deployment already unhealthy
- containers restarting before these changes deploy
- runtime image differs from image declared in Git

Never silently modify source to match runtime.

## Future adapters

- Komodo API
- Arcane API
- Docker API proxy / lightweight agent
- none

## Product guardrail

RuntimeProvider exists to support **source editing confidence** and **Deployment Watch**, not to become a container control plane.
