import { describe, expect, it } from 'vitest';
import { ValidationError } from '@/server/domain/errors';
import { gitAuthorIdentityOf, parseGitAuthorIdentity, type User } from '@/server/domain/user';

const baseUser = {
  id: 'u1',
  username: 'admin',
  role: 'admin' as const,
  createdAt: new Date(0),
  lastLoginAt: null,
  disabledAt: null,
};

describe('parseGitAuthorIdentity', () => {
  it('trims a valid identity', () => {
    expect(parseGitAuthorIdentity({ name: ' Alice ', email: ' alice@example.invalid ' })).toEqual({
      name: 'Alice',
      email: 'alice@example.invalid',
    });
  });

  it.each([
    [{ name: '', email: 'a@b.c' }, 'name' as const],
    [{ name: '  ', email: 'a@b.c' }, 'name' as const],
    [{ name: 'A\nB', email: 'a@b.c' }, 'name' as const],
    [{ name: 'Alice', email: '' }, 'email' as const],
    [{ name: 'Alice', email: 'not-an-email' }, 'email' as const],
    [{ name: 'Alice', email: 'bad<addr>@x.y' }, 'email' as const],
  ])('rejects %#', (input, field) => {
    expect(() => parseGitAuthorIdentity(input)).toThrow(ValidationError);
    try {
      parseGitAuthorIdentity(input);
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).fields?.[field]).toBeTruthy();
    }
  });
});

describe('gitAuthorIdentityOf', () => {
  it('returns null when either field is unset', () => {
    expect(gitAuthorIdentityOf({ ...baseUser, gitAuthorName: null, gitAuthorEmail: null })).toBeNull();
    expect(
      gitAuthorIdentityOf({ ...baseUser, gitAuthorName: 'Alice', gitAuthorEmail: null } as User),
    ).toBeNull();
  });

  it('returns the configured pair', () => {
    expect(
      gitAuthorIdentityOf({
        ...baseUser,
        gitAuthorName: 'Alice',
        gitAuthorEmail: 'alice@example.invalid',
      }),
    ).toEqual({ name: 'Alice', email: 'alice@example.invalid' });
  });
});
