import { describe, expect, it } from 'vitest';
import {
  maskSecret,
  toCredentialView,
  validateSecretMeta,
  type CredentialRecord,
} from '@/server/domain/credential';
import { ValidationError } from '@/server/domain/errors';
import {
  normalizeRemoteUrl,
  repositoryNameFromUrl,
  validateBranchName,
} from '@/server/domain/git-repository';
import { normalizeUsername } from '@/server/domain/user';
import { slugify, validateWorkspaceName } from '@/server/domain/workspace';

describe('normalizeRemoteUrl', () => {
  it('accepts https remotes and normalises the path', () => {
    expect(normalizeRemoteUrl(' https://github.com/org/repo.git ')).toBe('https://github.com/org/repo.git');
    expect(normalizeRemoteUrl('https://git.example.com//org//repo/')).toBe(
      'https://git.example.com/org/repo',
    );
  });

  it.each([
    'http://github.com/org/repo.git',
    'git://github.com/org/repo.git',
    'file:///etc/passwd',
    'ext::sh -c touch% /tmp/pwned',
    'git@github.com:org/repo.git',
    'ssh://git@github.com/org/repo.git',
    'https://user:token@github.com/org/repo.git',
    'https://token@github.com/org/repo.git',
    'https://github.com/org/repo.git?x=1',
    'https://github.com/',
    'https://github.com/org/../../etc',
    'https://github.com/org/%2e%2e/x',
    '-uhttps://github.com/org/repo',
    'https://github.com/org/re po',
    '',
  ])('rejects %j', (input) => {
    expect(() => normalizeRemoteUrl(input)).toThrow(ValidationError);
  });

  it('derives a display name', () => {
    expect(repositoryNameFromUrl('https://github.com/acme/infra.git')).toBe('acme/infra');
  });
});

describe('validateBranchName', () => {
  it.each(['main', 'release/1.2', 'feature_x'])('accepts %s', (b) => expect(validateBranchName(b)).toBe(b));
  it.each([
    '-main',
    '--upload-pack=x',
    'a..b',
    'a b',
    'x.lock',
    'a/',
    '/a',
    '.hidden',
    'a/.b',
    'a@{1}',
    'a~1',
    'a:b',
    '',
  ])('rejects %j', (b) => expect(() => validateBranchName(b)).toThrow(ValidationError));
});

describe('users and workspaces', () => {
  it('normalises usernames', () => {
    expect(normalizeUsername(' Admin ')).toBe('admin');
    expect(() => normalizeUsername('a')).toThrow(ValidationError);
    expect(() => normalizeUsername('bad name')).toThrow(ValidationError);
  });

  it('validates workspace names and slugs', () => {
    expect(validateWorkspaceName('  Home   lab ')).toBe('Home lab');
    expect(() => validateWorkspaceName('')).toThrow(ValidationError);
    expect(slugify('Homé Lab!')).toBe('home-lab');
    expect(slugify('!!!')).toBe('workspace');
  });
});

describe('credential view', () => {
  it('masks secrets', () => {
    expect(maskSecret('ghp_1234567890abcdef')).toBe('••••cdef');
    expect(maskSecret('short')).toBe('••••');
  });

  it('only allows non-secret metadata keys', () => {
    expect(validateSecretMeta({ username: 'bot' })).toEqual({ username: 'bot' });
    expect(() => validateSecretMeta({ token: 'x' })).toThrow(ValidationError);
    expect(() => validateSecretMeta({ password: 'x' })).toThrow(ValidationError);
  });

  it('structurally excludes ciphertext, nonce and plaintext from the view', () => {
    const record: CredentialRecord = {
      id: 'c1',
      workspaceId: 'w1',
      kind: 'git',
      providerType: 'github',
      label: 'Token',
      secretCiphertext: 'CIPHERTEXT',
      secretNonce: 'NONCE',
      secretKeyVersion: 1,
      secretHint: '••••abcd',
      secretMeta: {},
      lastTestedAt: null,
      lastTestStatus: null,
      lastTestMessage: null,
      createdByUserId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const json = JSON.stringify(toCredentialView(record));
    expect(json).not.toContain('CIPHERTEXT');
    expect(json).not.toContain('NONCE');
    expect(Object.keys(toCredentialView(record))).not.toContain('secretCiphertext');
  });
});

describe('isAppError', () => {
  it('recognises app errors by brand, including copies of the class from another bundle', async () => {
    const { isAppError, NotFoundError } = await import('@/server/domain/errors');
    expect(isAppError(new NotFoundError())).toBe(true);
    const foreign = Object.assign(new Error('x'), {
      [Symbol.for('stack-manager.AppError')]: true,
      status: 400,
    });
    expect(isAppError(foreign)).toBe(true);
    expect(isAppError(new Error('plain'))).toBe(false);
    expect(isAppError(null)).toBe(false);
  });
});
