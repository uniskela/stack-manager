import { describe, expect, it } from 'vitest';
import { resolveRelative, resolveRepoLink } from '@/shared/source/links';
import {
  isEnvTemplateName,
  isSecretPath,
  isWithin,
  languageFor,
  normalizeRepoPath,
  relativeTo,
  RepoPathError,
} from '@/shared/source/paths';

describe('normalizeRepoPath', () => {
  it('normalises separators, dot segments and slashes', () => {
    expect(normalizeRepoPath('./apps//liftlog/')).toBe('apps/liftlog');
    expect(normalizeRepoPath('\\apps\\liftlog\\compose.yaml')).toBe('apps/liftlog/compose.yaml');
    expect(normalizeRepoPath('/apps/./x.yml')).toBe('apps/x.yml');
    expect(normalizeRepoPath('', { allowRoot: true })).toBe('');
    expect(normalizeRepoPath('.', { allowRoot: true })).toBe('');
  });

  it('rejects traversal, .git, control characters, empty and over-long paths', () => {
    for (const bad of [
      '../etc/passwd',
      'apps/../../x',
      '.git/config',
      'a/.GIT/HEAD',
      'a\u0000b',
      'a\nb',
      '',
      '   ',
      'x'.repeat(1025),
    ]) {
      expect(() => normalizeRepoPath(bad), JSON.stringify(bad)).toThrow(RepoPathError);
    }
  });
});

describe('scoping helpers', () => {
  it('isWithin / relativeTo treat "" as the repository root and avoid prefix confusion', () => {
    expect(isWithin('', 'anything/at/all')).toBe(true);
    expect(isWithin('apps/lift', 'apps/lift/compose.yaml')).toBe(true);
    expect(isWithin('apps/lift', 'apps/lift')).toBe(true);
    expect(isWithin('apps/lift', 'apps/liftlog/compose.yaml')).toBe(false);
    expect(relativeTo('apps/lift', 'apps/lift/a/b.md')).toBe('a/b.md');
    expect(relativeTo('', 'a/b.md')).toBe('a/b.md');
  });
});

describe('isSecretPath', () => {
  it('locks dotenv files, keys and secrets/ directories but not templates', () => {
    for (const p of [
      '.env',
      'apps/x/.env',
      '.env.production',
      '.env.local',
      'prod.env',
      'certs/tls.key',
      'tls.pem',
      'id_ed25519',
      'id_rsa',
      'secrets/db.txt',
      'apps/Secrets/token',
      '.htpasswd',
      'backup.kdbx',
    ]) {
      expect(isSecretPath(p), p).toBe(true);
    }
    for (const p of [
      '.env.example',
      'apps/.env.sample',
      '.env.template',
      '.env.dist',
      'app.example.env',
      'compose.yaml',
      'README.md',
      'id_rsa.pub',
      'docs/secrets.md',
      'env/config.yml',
    ]) {
      expect(isSecretPath(p), p).toBe(false);
    }
  });

  it('recognises env templates', () => {
    expect(isEnvTemplateName('.env.example')).toBe(true);
    expect(isEnvTemplateName('.env')).toBe(false);
  });
});

describe('languageFor', () => {
  it('maps common stack files to editor languages', () => {
    expect(languageFor('compose.yaml')).toBe('yaml');
    expect(languageFor('docs/README.md')).toBe('markdown');
    expect(languageFor('config/app.json')).toBe('json');
    expect(languageFor('.env.example')).toBe('dotenv');
    expect(languageFor('scripts/run.sh')).toBe('shell');
    expect(languageFor('Dockerfile')).toBe('dockerfile');
    expect(languageFor('LICENSE')).toBe('text');
  });
});

describe('resolveRepoLink', () => {
  const ctx = { docPath: 'apps/lift/docs/guide.md', rootPath: 'apps/lift', editorHref: '/e', docsHref: '/d' };
  it('maps relative links to the Docs or Editor tab', () => {
    expect(resolveRepoLink('../compose.yaml', ctx)).toBe('/e?file=compose.yaml');
    expect(resolveRepoLink('./setup.md#install', ctx)).toBe('/d?doc=docs%2Fsetup.md');
    expect(resolveRepoLink('#section', ctx)).toBe('#section');
  });
  it('refuses links that leave the stack or the repository', () => {
    expect(resolveRepoLink('../../other/compose.yaml', ctx)).toBeNull();
    expect(resolveRepoLink('../../../../../etc/passwd', ctx)).toBeNull();
    expect(resolveRepoLink('../.git/config', ctx)).toBeNull();
  });
});

describe('resolveRelative', () => {
  it('resolves ./ and ../ against a directory and refuses to leave the repository', () => {
    expect(resolveRelative('apps/lift', '../shared/app.env')).toBe('apps/shared/app.env');
    expect(resolveRelative('apps/lift', './.env')).toBe('apps/lift/.env');
    expect(resolveRelative('', 'a/./b')).toBe('a/b');
    expect(() => resolveRelative('apps', '../../x')).toThrow();
  });
});
