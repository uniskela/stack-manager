import { spawn } from 'node:child_process';
import { scrubString } from '@/server/security/redact';
import { GitOperationError, type GitHttpAuth } from './types';

export interface GitCliOptions {
  /** Path to the git binary. */
  binary?: string;
  /** Protocols git may use (GIT_ALLOW_PROTOCOL). Production: ['https']. Tests may add 'file'. */
  allowedProtocols?: readonly string[];
  /** Isolated HOME for git (no user-level config or credential helpers). */
  homeDir: string;
  defaultTimeoutMs?: number;
  /** Additional `-c` style config (tests use `url.<base>.insteadOf` to point at a local server). */
  extraConfig?: ReadonlyArray<readonly [string, string]>;
}

export interface GitRunOptions {
  cwd?: string;
  auth?: GitHttpAuth | null;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Cap on collected stdout+stderr (default 4 MiB). Output beyond it is dropped and `truncated` is set. */
  maxOutputBytes?: number;
}

const MAX_OUTPUT = 4 * 1024 * 1024;
const PASSTHROUGH_ENV = [
  'PATH',
  'HTTPS_PROXY',
  'https_proxy',
  'NO_PROXY',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
];

/**
 * Runs the `git` binary without a shell (argv array, no interpolation) in a locked-down environment:
 *
 * - no system/global config, isolated HOME, no credential helpers, no terminal/askpass prompts;
 * - hooks disabled, redirects not followed (so auth headers are never replayed to another host);
 * - protocol allowlist via GIT_ALLOW_PROTOCOL;
 * - credentials passed as an `http.extraHeader` through GIT_CONFIG_* environment variables — never
 *   in argv, remote URLs or `.git/config` — and scrubbed from any error output.
 */
export class GitCli {
  readonly #binary: string;
  readonly #allowedProtocols: string;
  readonly #homeDir: string;
  readonly #defaultTimeoutMs: number;
  readonly #extraConfig: ReadonlyArray<readonly [string, string]>;

  constructor(options: GitCliOptions) {
    this.#binary = options.binary ?? 'git';
    this.#allowedProtocols = (options.allowedProtocols ?? ['https']).join(':');
    this.#homeDir = options.homeDir;
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? 120_000;
    this.#extraConfig = options.extraConfig ?? [];
  }

  async run(
    args: readonly string[],
    options: GitRunOptions = {},
  ): Promise<{ stdout: string; stderr: string; truncated: boolean }> {
    const secrets: string[] = [];
    const config: Array<readonly [string, string]> = [
      ['core.hooksPath', '/dev/null'],
      ['core.askPass', ''],
      ['credential.helper', ''],
      ['http.followRedirects', 'false'],
      ['protocol.allow', 'never'],
      ...this.#allowedProtocols.split(':').map((p): [string, string] => [`protocol.${p}.allow`, 'always']),
      ['submodule.recurse', 'false'],
      ['core.fsmonitor', 'false'],
      ['commit.gpgSign', 'false'],
      ['gc.auto', '0'],
      ['maintenance.auto', 'false'],
      ['transfer.fsckObjects', 'true'],
      ...this.#extraConfig,
    ];
    if (options.auth) {
      const basic = Buffer.from(`${options.auth.username}:${options.auth.token}`, 'utf8').toString('base64');
      secrets.push(options.auth.token, basic);
      config.push(['http.extraHeader', `Authorization: Basic ${basic}`]);
    }

    const env: Record<string, string> = {
      HOME: this.#homeDir,
      XDG_CONFIG_HOME: this.#homeDir,
      LC_ALL: 'C',
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '',
      SSH_ASKPASS: '',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_ALLOW_PROTOCOL: this.#allowedProtocols,
      GIT_PROTOCOL_FROM_USER: '0',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_CONFIG_COUNT: String(config.length),
    };
    for (const key of PASSTHROUGH_ENV) {
      const value = process.env[key];
      if (value) env[key] = value;
    }
    config.forEach(([k, v], i) => {
      env[`GIT_CONFIG_KEY_${i}`] = k;
      env[`GIT_CONFIG_VALUE_${i}`] = v;
    });

    const timeoutMs = options.timeoutMs ?? this.#defaultTimeoutMs;
    const maxOutput = options.maxOutputBytes ?? MAX_OUTPUT;

    return new Promise((resolve, reject) => {
      const child = spawn(this.#binary, [...args], {
        cwd: options.cwd,
        env: env as NodeJS.ProcessEnv,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        signal: options.signal,
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let size = 0;
      let truncated = false;
      const collect = (sink: Buffer[]) => (chunk: Buffer) => {
        size += chunk.length;
        if (size <= maxOutput) sink.push(chunk);
        else truncated = true;
      };
      child.stdout.on('data', collect(out));
      child.stderr.on('data', collect(err));
      child.on('error', (error) => {
        const aborted = (error as NodeJS.ErrnoException).code === 'ABORT_ERR';
        reject(
          new GitOperationError(
            aborted ? 'timeout' : 'unknown',
            aborted
              ? 'Git operation was cancelled.'
              : `Could not run git: ${scrubString(error.message, { secrets })}`,
          ),
        );
      });
      child.on('close', (code, signal) => {
        const stdout = Buffer.concat(out).toString('utf8');
        const stderr = scrubString(Buffer.concat(err).toString('utf8'), { secrets });
        if (code === 0) return resolve({ stdout, stderr, truncated });
        if (signal === 'SIGKILL') {
          return reject(
            new GitOperationError(
              'timeout',
              `Git operation timed out after ${Math.round(timeoutMs / 1000)}s.`,
            ),
          );
        }
        reject(classifyGitFailure(`${scrubString(stdout, { secrets })}\n${stderr}`));
      });
    });
  }
}

export function classifyGitFailure(stderr: string): GitOperationError {
  const text = stderr.trim();
  const firstLines = text
    .split('\n')
    .filter((l) => l.trim())
    .slice(-3)
    .join(' ')
    .slice(0, 400);
  if (/\[rejected\]|\[remote rejected\]|non-fast-forward|pre-receive hook declined/i.test(text)) {
    return new GitOperationError(
      'rejected',
      'The remote rejected the push. Fetch and review the branch before retrying.',
    );
  }
  if (/remote branch .* not found/i.test(text)) {
    return new GitOperationError('invalid', 'That branch does not exist on the remote.');
  }
  if (
    /authentication failed|could not read username|terminal prompts disabled|invalid credentials|HTTP 401|returned error: 40[13]|403/i.test(
      text,
    )
  ) {
    return new GitOperationError(
      'auth',
      'Authentication failed. Check the token and its repository permissions.',
    );
  }
  if (
    /repository .* not found|not found|HTTP 404|returned error: 404|does not appear to be a git repository/i.test(
      text,
    )
  ) {
    return new GitOperationError('not_found', 'Repository not found, or the credential cannot see it.');
  }
  if (
    /could not resolve host|connection refused|timed out|unable to access|SSL|certificate|network is unreachable/i.test(
      text,
    )
  ) {
    return new GitOperationError('network', `Could not reach the remote: ${firstLines}`);
  }
  if (/redirect/i.test(text)) {
    return new GitOperationError(
      'invalid',
      'The remote redirected; redirects are not followed. Use the canonical clone URL.',
    );
  }
  return new GitOperationError('unknown', firstLines || 'Git command failed.');
}
