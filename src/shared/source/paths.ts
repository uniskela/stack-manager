/**
 * Repository path rules shared by the server and the editor UI. Paths are always repo-relative POSIX
 * paths with no leading slash; `''` is the repository root. Pure functions only (no Node or DOM APIs).
 */

export const MAX_PATH_LENGTH = 1024;

export class RepoPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepoPathError';
  }
}

/**
 * Normalises a user- or client-supplied path: trims, converts `\` to `/`, strips leading `./` and `/`,
 * collapses duplicate slashes and trailing slashes. Rejects `..`, `.` segments, NUL/control
 * characters, `.git` segments and over-long paths.
 */
export function normalizeRepoPath(input: string, { allowRoot = false } = {}): string {
  if (typeof input !== 'string') throw new RepoPathError('Path is required.');
  if (/[\u0000-\u001f\u007f]/.test(input)) throw new RepoPathError('Path contains control characters.');
  const trimmed = input.trim().replace(/\\/g, '/');
  const segments = trimmed.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.length === 0) {
    if (allowRoot) return '';
    throw new RepoPathError('Path is required.');
  }
  for (const s of segments) {
    if (s === '..') throw new RepoPathError('Path must not contain "..".');
    if (s.toLowerCase() === '.git') throw new RepoPathError('The .git directory is not accessible.');
  }
  const out = segments.join('/');
  if (out.length > MAX_PATH_LENGTH) throw new RepoPathError('Path is too long.');
  return out;
}

/** True when `path` is `root` itself or inside it. `root === ''` is the repository root. */
export function isWithin(root: string, path: string): boolean {
  return root === '' || path === root || path.startsWith(`${root}/`);
}

/** Path relative to `root` (for display inside a stack). */
export function relativeTo(root: string, path: string): string {
  if (root === '') return path;
  return path === root ? '' : path.slice(root.length + 1);
}

export function joinRepoPath(...parts: string[]): string {
  return parts.filter((p) => p !== '').join('/');
}

export function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

export function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

export const COMPOSE_FILE_NAMES = [
  'compose.yaml',
  'compose.yml',
  'docker-compose.yaml',
  'docker-compose.yml',
];

export function isComposeFileName(name: string): boolean {
  return COMPOSE_FILE_NAMES.includes(name);
}

const ENV_TEMPLATE = /^\.env\.(example|sample|template|dist|defaults)$/i;

/**
 * Files whose contents are never sent to the browser or accepted as drafts: dotenv files (other than
 * documented templates such as `.env.example`), private keys and keystores, and anything under a
 * `secrets/` directory. Their presence is still shown in the file tree as locked.
 */
export function isSecretPath(path: string): boolean {
  const name = basename(path).toLowerCase();
  if (name === '.env' || (name.startsWith('.env.') && !ENV_TEMPLATE.test(name))) return true;
  if (/\.env$/i.test(name) && name !== '.env' && !name.endsWith('.example.env')) return true;
  if (/\.(pem|key|p12|pfx|jks|keystore|kdbx|gpg|asc)$/i.test(name)) return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)$/i.test(name)) return true;
  if (/^(credentials|\.netrc|\.htpasswd|\.pgpass)$/i.test(name)) return true;
  return path.toLowerCase().split('/').slice(0, -1).includes('secrets');
}

export function isEnvTemplateName(name: string): boolean {
  return ENV_TEMPLATE.test(name) || name.toLowerCase().endsWith('.example.env');
}

export type SourceLanguage =
  'yaml' | 'markdown' | 'json' | 'dotenv' | 'shell' | 'dockerfile' | 'toml' | 'text';

export function languageFor(path: string): SourceLanguage {
  const name = basename(path).toLowerCase();
  if (/\.(ya?ml)$/.test(name)) return 'yaml';
  if (/\.(md|markdown|mdx)$/.test(name)) return 'markdown';
  if (/\.(json|jsonc)$/.test(name)) return 'json';
  if (name.startsWith('.env') || name.endsWith('.env')) return 'dotenv';
  if (/\.(sh|bash|zsh)$/.test(name)) return 'shell';
  if (name === 'dockerfile' || name.startsWith('dockerfile.') || name.endsWith('.dockerfile'))
    return 'dockerfile';
  if (name.endsWith('.toml')) return 'toml';
  return 'text';
}

export function isMarkdownPath(path: string): boolean {
  return languageFor(path) === 'markdown';
}
