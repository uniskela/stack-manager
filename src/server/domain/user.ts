import { ValidationError } from './errors';

export type UserRole = 'admin';

export interface GitAuthorIdentity {
  name: string;
  email: string;
}

export interface User {
  id: string;
  username: string;
  role: UserRole;
  gitAuthorName: string | null;
  gitAuthorEmail: string | null;
  createdAt: Date;
  lastLoginAt: Date | null;
  disabledAt: Date | null;
}

export interface UserWithPasswordHash extends User {
  passwordHash: string;
}

export interface Session {
  id: string;
  userId: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  userAgent: string | null;
}

const USERNAME = /^[a-z0-9][a-z0-9._-]{1,30}[a-z0-9]$/;
const CONTROL_OR_ANGLE = /[\u0000-\u001f\u007f<>]/;
/** Practical email shape; full RFC 5322 is not required for Git author headers. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Usernames are case-insensitive and stored lower-cased. */
export function normalizeUsername(input: string): string {
  const username = input.trim().toLowerCase();
  if (!USERNAME.test(username)) {
    throw new ValidationError('Invalid username.', {
      username:
        '3–32 characters: letters, digits, dot, dash or underscore; start and end with a letter or digit.',
    });
  }
  return username;
}

/** Returns the configured Git author identity, or null when either field is unset. */
export function gitAuthorIdentityOf(user: User): GitAuthorIdentity | null {
  if (!user.gitAuthorName || !user.gitAuthorEmail) return null;
  return { name: user.gitAuthorName, email: user.gitAuthorEmail };
}

/** Validates and trims a Git author name/email pair used for commits created by Stack Manager. */
export function parseGitAuthorIdentity(input: { name: unknown; email: unknown }): GitAuthorIdentity {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const email = typeof input.email === 'string' ? input.email.trim() : '';
  const fields: Record<string, string> = {};
  if (!name) fields.name = 'Enter a name.';
  else if (name.length > 200) fields.name = 'Use at most 200 characters.';
  else if (CONTROL_OR_ANGLE.test(name)) fields.name = 'Name cannot contain control characters or < >.';
  if (!email) fields.email = 'Enter an email address.';
  else if (email.length > 254) fields.email = 'Use at most 254 characters.';
  else if (CONTROL_OR_ANGLE.test(email) || !EMAIL.test(email)) fields.email = 'Enter a valid email address.';
  if (Object.keys(fields).length) throw new ValidationError('Invalid Git identity.', fields);
  return { name, email };
}
