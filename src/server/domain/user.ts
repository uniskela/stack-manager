import { ValidationError } from './errors';

export type UserRole = 'admin';

export interface User {
  id: string;
  username: string;
  role: UserRole;
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
