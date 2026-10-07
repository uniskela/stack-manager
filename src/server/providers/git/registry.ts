import { ValidationError } from '@/server/domain/errors';
import type { GitCli } from './git-cli';
import { HttpGitProvider } from './http-git-provider';
import type { GitProvider, GitProviderDescriptor } from './types';

/** Built-in forge descriptors. GitLab is planned; add a descriptor (and adapter if needed) here. */
export const BUILTIN_GIT_PROVIDERS: readonly GitProviderDescriptor[] = [
  {
    type: 'github',
    displayName: 'GitHub',
    exampleUrl: 'https://github.com/your-org/compose-stacks.git',
    tokenHelp:
      'Fine-grained token with Contents: read (browse and draft) or read and write (also push commits).',
    capabilities: { pullRequests: false, commitStatuses: false, webhooks: false },
  },
  {
    type: 'gitea',
    displayName: 'Gitea',
    exampleUrl: 'https://gitea.example.com/your-org/compose-stacks.git',
    tokenHelp:
      'Access token with repository read scope (browse and draft), plus write scope to push commits.',
    capabilities: { pullRequests: false, commitStatuses: false, webhooks: false },
  },
  {
    type: 'forgejo',
    displayName: 'Forgejo',
    exampleUrl: 'https://forgejo.example.com/your-org/compose-stacks.git',
    tokenHelp:
      'Access token with repository read scope (browse and draft), plus write scope to push commits.',
    capabilities: { pullRequests: false, commitStatuses: false, webhooks: false },
  },
];

export class GitProviderRegistry {
  readonly #providers = new Map<string, GitProvider>();

  register(provider: GitProvider): void {
    this.#providers.set(provider.descriptor.type, provider);
  }

  get(type: string): GitProvider {
    const provider = this.#providers.get(type);
    if (!provider) {
      throw new ValidationError('Unsupported Git provider.', {
        gitProviderType: 'Choose one of the supported providers.',
      });
    }
    return provider;
  }

  has(type: string): boolean {
    return this.#providers.has(type);
  }

  descriptors(): GitProviderDescriptor[] {
    return [...this.#providers.values()].map((p) => p.descriptor);
  }
}

export function createDefaultGitProviderRegistry(git: GitCli, reposDir: string): GitProviderRegistry {
  const registry = new GitProviderRegistry();
  for (const descriptor of BUILTIN_GIT_PROVIDERS)
    registry.register(new HttpGitProvider(descriptor, git, undefined, reposDir));
  return registry;
}
