import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

/**
 * Minimal smart-HTTP Git server (git http-backend behind Node's http module) with Basic auth,
 * so tests exercise the real network path: auth header delivery, 401 handling, clone and fetch.
 * Tests address it as https://git.test/… and the GitCli rewrites that to this server via insteadOf.
 */
export interface GitServer {
  baseUrl: string;
  root: string;
  authHeaders: string[];
  requestUrls: string[];
  createRepo(name: string, branches?: string[]): void;
  commit(name: string, branch: string, file: string, content: string): string;
  /** Commits several files at once; `{ symlink }` creates a symlink and `null` deletes the path. */
  commitFiles(
    name: string,
    branch: string,
    files: Record<string, string | { symlink: string } | null>,
  ): string;
  close(): Promise<void>;
}

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
};

export async function startGitServer(
  options: { username?: string; token?: string } = {},
): Promise<GitServer> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stack-manager-git-'));
  const authHeaders: string[] = [];
  const requestUrls: string[] = [];
  const expected = options.token
    ? `Basic ${Buffer.from(`${options.username ?? 'x-access-token'}:${options.token}`).toString('base64')}`
    : null;

  const server = http.createServer((req, res) => {
    requestUrls.push(req.url ?? '');
    const auth = req.headers.authorization ?? '';
    if (auth) authHeaders.push(auth);
    if (expected && auth !== expected) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="git"' });
      res.end('unauthorized');
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const cgi = spawn('git', ['http-backend'], {
      env: {
        ...gitEnv,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: decodeURIComponent(url.pathname),
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: req.method ?? 'GET',
        CONTENT_TYPE: req.headers['content-type'] ?? '',
        HTTP_GIT_PROTOCOL: String(req.headers['git-protocol'] ?? ''),
        REMOTE_USER: 'test',
        REMOTE_ADDR: '127.0.0.1',
      },
    });
    req.pipe(cgi.stdin);
    let buffer = Buffer.alloc(0);
    let headersDone = false;
    cgi.stdout.on('data', (chunk: Buffer) => {
      if (headersDone) return void res.write(chunk);
      buffer = Buffer.concat([buffer, chunk]);
      const idx = buffer.indexOf('\r\n\r\n');
      if (idx === -1) return;
      headersDone = true;
      let status = 200;
      for (const line of buffer.subarray(0, idx).toString().split('\r\n')) {
        const [k, ...rest] = line.split(':');
        const v = rest.join(':').trim();
        if (!k) continue;
        if (k.toLowerCase() === 'status') status = parseInt(v, 10);
        else res.setHeader(k, v);
      }
      res.writeHead(status);
      res.write(buffer.subarray(idx + 4));
    });
    cgi.on('close', () => res.end());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  const work = (name: string) => path.join(root, `.work-${name}`);

  return {
    baseUrl: `http://127.0.0.1:${port}/`,
    root,
    authHeaders,
    requestUrls,
    createRepo(name, branches = ['main']) {
      const bare = path.join(root, name);
      execFileSync('git', ['init', '--bare', '-q', '-b', branches[0]!, bare], { env: gitEnv });
      const wt = work(name);
      execFileSync('git', ['clone', '-q', bare, wt], { env: gitEnv, stdio: 'ignore' });
      execFileSync('git', ['checkout', '-q', '-b', branches[0]!], { cwd: wt, env: gitEnv });
      fs.writeFileSync(path.join(wt, 'compose.yaml'), 'services:\n  app:\n    image: nginx:1.27\n');
      execFileSync('git', ['add', '.'], { cwd: wt, env: gitEnv });
      execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: wt, env: gitEnv });
      execFileSync('git', ['push', '-q', 'origin', branches[0]!], { cwd: wt, env: gitEnv });
      for (const b of branches.slice(1))
        execFileSync('git', ['push', '-q', 'origin', `HEAD:refs/heads/${b}`], { cwd: wt, env: gitEnv });
    },
    commit(name, branch, file, content) {
      const wt = work(name);
      execFileSync('git', ['checkout', '-q', '-B', branch], { cwd: wt, env: gitEnv });
      fs.writeFileSync(path.join(wt, file), content);
      execFileSync('git', ['add', '.'], { cwd: wt, env: gitEnv });
      execFileSync('git', ['commit', '-q', '-m', `update ${file}`], { cwd: wt, env: gitEnv });
      execFileSync('git', ['push', '-q', 'origin', `${branch}:${branch}`], { cwd: wt, env: gitEnv });
      return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: wt, env: gitEnv }).toString().trim();
    },
    commitFiles(name, branch, files) {
      const wt = work(name);
      execFileSync('git', ['checkout', '-q', '-B', branch], { cwd: wt, env: gitEnv });
      for (const [file, content] of Object.entries(files)) {
        const target = path.join(wt, file);
        fs.rmSync(target, { force: true, recursive: true });
        if (content === null) continue;
        fs.mkdirSync(path.dirname(target), { recursive: true });
        if (typeof content === 'string') fs.writeFileSync(target, content);
        else fs.symlinkSync(content.symlink, target);
      }
      execFileSync('git', ['add', '-A'], { cwd: wt, env: gitEnv });
      execFileSync('git', ['commit', '-q', '-m', 'update files'], { cwd: wt, env: gitEnv });
      execFileSync('git', ['push', '-q', 'origin', `${branch}:${branch}`], { cwd: wt, env: gitEnv });
      return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: wt, env: gitEnv }).toString().trim();
    },
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Container overrides that route https://git.test/ to the local server. */
export function gitServerOverrides(server: GitServer) {
  return {
    gitAllowedProtocols: ['https', 'http'] as const,
    gitExtraConfig: [[`url.${server.baseUrl}.insteadOf`, 'https://git.test/']] as const,
  };
}
