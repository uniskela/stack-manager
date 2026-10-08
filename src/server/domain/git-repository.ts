import { ValidationError } from './errors';

export type RepositorySyncStatus = 'pending' | 'syncing' | 'ready' | 'error';

export interface GitRepositoryConnection {
  id: string;
  workspaceId: string;
  name: string;
  /** Registered GitProvider type (e.g. github, gitea, forgejo). Core code never assumes a specific forge. */
  gitProviderType: string;
  remoteUrl: string;
  defaultBranch: string;
  credentialId: string | null;
  webhookCredentialId: string | null;
  /** Relative to the data directory. */
  localClonePath: string;
  syncStatus: RepositorySyncStatus;
  lastSyncError: string | null;
  headSha: string | null;
  lastFetchedAt: Date | null;
  /** Register every Compose folder as a stack after each successful fetch (docs/public/STACK_DISCOVERY.md). */
  autoAddStacks: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Validates and normalises a Git remote URL.
 *
 * PR #2 accepts HTTPS remotes only: credentials are sent as an HTTP header, so plaintext
 * `http://` and `git://` are rejected up-front (docs/public/SECURITY.md). SSH remotes are deferred until
 * host-key management exists. Embedded credentials (`https://user:token@…`) are rejected so
 * tokens are never persisted in URLs, logs or `.git/config`.
 */
export function normalizeRemoteUrl(input: string): string {
  const raw = input.trim();
  const fail = (msg: string): never => {
    throw new ValidationError('Invalid remote URL.', { remoteUrl: msg });
  };
  if (!raw) fail('Required.');
  if (raw.length > 2048) fail('URL is too long.');
  if (/[\s\u0000-\u001f\u007f\\]/.test(raw))
    fail('URL must not contain whitespace, control characters or backslashes.');
  if (/(^|\/)(\.|%2e){1,2}(\/|$)/i.test(raw.split(/[?#]/)[0] ?? ''))
    fail('Path traversal segments are not allowed.');
  if (/^(git@|ssh:\/\/)/i.test(raw)) fail('SSH remotes are not supported yet. Use the HTTPS clone URL.');

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail('Enter a full HTTPS clone URL, e.g. https://git.example.com/org/repo.git');
  }
  if (url.protocol !== 'https:')
    fail('Only https:// remotes are supported; plaintext protocols would expose credentials.');
  if (url.username || url.password)
    fail('Do not embed credentials in the URL. Add a token as a credential instead.');
  if (!url.hostname) fail('Host is required.');
  if (url.search || url.hash) fail('Query strings and fragments are not allowed.');
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length < 1) fail('Include the repository path, e.g. /org/repo.git');
  if (segments.some((s) => s === '.' || s === '..' || safeDecode(s).includes('..'))) {
    fail('Path traversal segments are not allowed.');
  }
  url.pathname = `/${segments.join('/')}`;
  return url.toString();
}

/** Mirrors the important parts of `git check-ref-format --branch`. */
export function validateBranchName(input: string, field = 'defaultBranch'): string {
  const name = input.trim();
  const ok =
    name.length > 0 &&
    name.length <= 200 &&
    !name.startsWith('-') &&
    !name.startsWith('/') &&
    !name.endsWith('/') &&
    !name.endsWith('.') &&
    !name.endsWith('.lock') &&
    !name.includes('..') &&
    !name.includes('//') &&
    !name.includes('@{') &&
    name !== '@' &&
    !/[\u0000- ~^:?*[\\\u007f]/.test(name) &&
    !name.split('/').some((part) => part.startsWith('.'));
  if (!ok) throw new ValidationError('Invalid branch name.', { [field]: 'Not a valid Git branch name.' });
  return name;
}

export function validateRepositoryName(input: string): string {
  const name = input.trim().replace(/\s+/g, ' ');
  if (name.length < 1 || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new ValidationError('Invalid repository name.', { name: 'Use 1–100 printable characters.' });
  }
  return name;
}

/** Suggests a display name from the remote path: https://host/org/infra.git → "org/infra". */
export function repositoryNameFromUrl(remoteUrl: string): string {
  const segments = new URL(remoteUrl).pathname.split('/').filter(Boolean);
  const tail = segments
    .slice(-2)
    .join('/')
    .replace(/\.git$/i, '');
  return tail || new URL(remoteUrl).hostname;
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return '..'; // malformed escapes are treated as hostile
  }
}
