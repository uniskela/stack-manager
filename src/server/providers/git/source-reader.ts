import type { GitCli } from './git-cli';
import { GitOperationError, type SourceTreeEntry, type SourceTreeReader } from './types';

const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
/** Upper bound on tree entries served to the UI; larger monorepos need scoped reads (later). */
export const MAX_TREE_ENTRIES = 50_000;

/** SourceTreeReader backed by `git ls-tree` / `git cat-file` through the hardened GitCli. */
export class GitSourceReader implements SourceTreeReader {
  readonly #cache = new Map<string, SourceTreeEntry[]>();

  constructor(
    private readonly git: GitCli,
    private readonly cacheSize = 8,
  ) {}

  async listTree(cloneDir: string, commitSha: string): Promise<SourceTreeEntry[]> {
    assertObjectId(commitSha);
    const key = `${cloneDir}\0${commitSha}`;
    const cached = this.#cache.get(key);
    if (cached) {
      // Refresh LRU position.
      this.#cache.delete(key);
      this.#cache.set(key, cached);
      return cached;
    }
    const { stdout, truncated } = await this.git.run(
      ['ls-tree', '-r', '-l', '-z', '--full-tree', commitSha],
      {
        cwd: cloneDir,
        timeoutMs: 30_000,
        maxOutputBytes: 32 * 1024 * 1024,
      },
    );
    const entries = parseLsTree(stdout);
    if (truncated || entries.length > MAX_TREE_ENTRIES) {
      throw new GitOperationError('invalid', `The repository has more than ${MAX_TREE_ENTRIES} files.`);
    }
    this.#cache.set(key, entries);
    while (this.#cache.size > this.cacheSize) this.#cache.delete(this.#cache.keys().next().value!);
    return entries;
  }

  async readBlob(cloneDir: string, blobSha: string): Promise<string> {
    assertObjectId(blobSha);
    const { stdout, truncated } = await this.git.run(['cat-file', 'blob', blobSha], {
      cwd: cloneDir,
      timeoutMs: 30_000,
    });
    if (truncated) throw new GitOperationError('invalid', 'The file is too large to read.');
    return stdout;
  }
}

function assertObjectId(sha: string) {
  if (!OBJECT_ID.test(sha)) throw new GitOperationError('invalid', 'Invalid object id.');
}

/** Parses `git ls-tree -r -l -z` output: `<mode> SP <type> SP <object> SP+ <size> TAB <path> NUL`. */
export function parseLsTree(stdout: string): SourceTreeEntry[] {
  const entries: SourceTreeEntry[] = [];
  for (const record of stdout.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    if (tab === -1) continue;
    const [mode, type, objectSha, size] = record.slice(0, tab).trim().split(/\s+/);
    const path = record.slice(tab + 1);
    if (!mode || !type || !objectSha || !path) continue;
    if (type === 'commit') {
      entries.push({ path, kind: 'submodule', executable: false, objectSha, size: 0 });
    } else if (type === 'blob') {
      entries.push({
        path,
        kind: mode === '120000' ? 'symlink' : 'file',
        executable: mode === '100755',
        objectSha,
        size: Number(size) || 0,
      });
    }
  }
  return entries;
}
