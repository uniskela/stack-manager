import { describe, expect, it } from 'vitest';
import { analyzeCompose, analyzeJson, analyzeYaml, parseEnvTemplate } from '@/shared/source/compose';
import { problemsFor } from '@/shared/source/problems';
import { parseLsTree } from '@/server/providers/git/source-reader';

const messages = (text: string) =>
  analyzeCompose(text).problems.map((p) => `${p.severity}@${p.line}: ${p.message}`);

describe('analyzeCompose', () => {
  it('accepts a clean file', () => {
    const r = analyzeCompose(
      'services:\n  app:\n    image: nginx:1.27\n    environment:\n      DB_URL: ${DB_URL}\n',
    );
    expect(r.problems).toEqual([]);
    expect(r.services).toEqual([
      { name: 'app', image: 'nginx:1.27', build: false, environmentKeys: ['DB_URL'], envFiles: [], line: 2 },
    ]);
    expect(r.variables).toEqual([{ name: 'DB_URL', line: 5, hasDefault: false, required: false }]);
  });

  it('reports syntax errors with positions', () => {
    const [p] = analyzeCompose('services:\n  app: [\n').problems;
    expect(p).toMatchObject({ severity: 'error', line: expect.any(Number) });
  });

  it('flags structural mistakes', () => {
    expect(messages('')).toEqual([
      'error@1: The file is empty. A Compose file needs a top-level `services:` mapping.',
    ]);
    expect(messages('- a\n')).toEqual([
      'error@1: The top level of a Compose file must be a mapping (key: value).',
    ]);
    expect(messages('networks: {}\n')).toEqual(['error@1: Missing top-level `services:` mapping.']);
    expect(messages('include:\n  - other.yaml\n')).toEqual([]);
    const out = messages(
      [
        'version: "3.9"',
        'services:',
        '  web:',
        '    image: nginx',
        '    depends_on: [db, cache]',
        '    networks: [front]',
        '    volumes:',
        '      - data:/var/lib/x',
        '      - ./local:/y',
        '  db:',
        '    restart: always',
        'bogus: 1',
        'x-common: {}',
      ].join('\n'),
    );
    expect(out).toEqual([
      'info@1: `version` is obsolete in the Compose Specification and is ignored.',
      'info@4: Image "nginx" is not pinned to a version tag or digest.',
      'error@5: Service "web" depends on unknown service "cache".',
      'warning@6: Network "front" is not defined under top-level `networks:`.',
      'warning@8: Named volume "data" is not defined under top-level `volumes:`.',
      'error@10: Service "db" needs an `image` or a `build` section.',
      'warning@12: Unknown top-level key "bogus". Extension fields must start with "x-".',
    ]);
  });

  it('warns about hard-coded secrets but not interpolated ones', () => {
    const r = analyzeCompose(
      'services:\n  db:\n    image: postgres:16\n    environment:\n      - POSTGRES_PASSWORD=hunter2\n      - POSTGRES_USER=app\n      - API_TOKEN=${API_TOKEN}\n',
    );
    expect(r.problems).toEqual([
      expect.objectContaining({ code: 'hardcoded-secret', line: 5, severity: 'warning' }),
    ]);
    expect(r.services[0]!.environmentKeys).toEqual(['POSTGRES_PASSWORD', 'POSTGRES_USER', 'API_TOKEN']);
  });

  it('collects variable references with modifiers, ignoring $$ escapes and comments', () => {
    const r = analyzeCompose(
      'services:\n  a:\n    image: x:${TAG:-1}\n    command: echo $$HOME $USER ${NEEDED:?set me}\n    # ${IGNORED}\n    env_file: [.env.a, { path: .env.b }]\n',
    );
    expect(r.variables).toEqual([
      { name: 'TAG', line: 3, hasDefault: true, required: false },
      { name: 'USER', line: 4, hasDefault: false, required: false },
      { name: 'NEEDED', line: 4, hasDefault: false, required: true },
    ]);
    expect(r.envFiles).toEqual(['.env.a', '.env.b']);
  });
});

describe('other analysers', () => {
  it('YAML and JSON syntax checks', () => {
    expect(analyzeYaml('a: 1\n')).toEqual([]);
    expect(analyzeYaml('a: [\n')[0]).toMatchObject({ severity: 'error' });
    expect(analyzeJson('{"a": 1}')).toEqual([]);
    expect(analyzeJson('{"a": }')[0]).toMatchObject({ severity: 'error', line: 1 });
  });

  it('problemsFor routes by file type', () => {
    expect(problemsFor('apps/x/compose.yaml', 'services:\n  a: {}\n')).toHaveLength(1);
    expect(problemsFor('apps/x/config.yaml', 'services:\n  a: {}\n')).toEqual([]);
    expect(problemsFor('apps/x/custom.yml', 'x: 1\n', 'apps/x/custom.yml')).toHaveLength(2);
    expect(problemsFor('README.md', '# hi')).toEqual([]);
  });

  it('parseEnvTemplate lists names only', () => {
    expect(parseEnvTemplate('# comment\nDB_URL=\nexport API_KEY=changeme\n  TZ = UTC\nnot a var\n')).toEqual([
      'DB_URL',
      'API_KEY',
      'TZ',
    ]);
  });
});

describe('parseLsTree', () => {
  it('parses files, executables, symlinks and submodules (NUL-separated, paths with spaces)', () => {
    const out = [
      '100644 blob 1111111111111111111111111111111111111111     120\tapps/a b/compose.yaml',
      '100755 blob 2222222222222222222222222222222222222222      10\tscripts/run.sh',
      '120000 blob 3333333333333333333333333333333333333333      11\tlink',
      '160000 commit 4444444444444444444444444444444444444444       -\tvendor/sub',
    ].join('\0');
    expect(parseLsTree(`${out}\0`)).toEqual([
      {
        path: 'apps/a b/compose.yaml',
        kind: 'file',
        executable: false,
        objectSha: '1'.repeat(40),
        size: 120,
      },
      { path: 'scripts/run.sh', kind: 'file', executable: true, objectSha: '2'.repeat(40), size: 10 },
      { path: 'link', kind: 'symlink', executable: false, objectSha: '3'.repeat(40), size: 11 },
      { path: 'vendor/sub', kind: 'submodule', executable: false, objectSha: '4'.repeat(40), size: 0 },
    ]);
  });
});
