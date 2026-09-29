import type { Clock } from '@/server/domain/clock';
import {
  AuthenticationError,
  ConflictError,
  ForbiddenError,
  RateLimitedError,
  ValidationError,
} from '@/server/domain/errors';
import { normalizeUsername, type Session, type User } from '@/server/domain/user';
import {
  hashPassword,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  verifyAgainstDummy,
  verifyPassword,
} from '@/server/security/password';
import { AttemptLimiter } from '@/server/security/rate-limit';
import { generateSessionToken, hashSessionToken, safeEqual } from '@/server/security/tokens';
import type { AuditService } from './audit-service';
import type { SessionRepository, UserRepository } from './ports';

export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
}

export interface AuthenticatedSession {
  user: User;
  session: Session;
}

/** Sliding sessions: activity refreshes expiry, at most once per this interval to limit writes. */
const TOUCH_INTERVAL_MS = 5 * 60_000;

export function validateNewPassword(password: unknown): string {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) {
    throw new ValidationError('Password is too short.', {
      password: `Use at least ${PASSWORD_MIN_LENGTH} characters.`,
    });
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    throw new ValidationError('Password is too long.', {
      password: `Use at most ${PASSWORD_MAX_LENGTH} characters.`,
    });
  }
  return password;
}

export class AuthService {
  readonly #loginLimiter = new AttemptLimiter(10, 15 * 60_000);

  constructor(
    private readonly users: UserRepository,
    private readonly sessions: SessionRepository,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly newId: () => string,
    private readonly options: { sessionSecret: Buffer; sessionTtlMs: number; setupToken: string | null },
  ) {}

  async isSetupRequired(): Promise<boolean> {
    return (await this.users.count()) === 0;
  }

  get setupTokenRequired(): boolean {
    return this.options.setupToken !== null;
  }

  /** First-run setup: creates the initial admin exactly once and signs them in. */
  async setupAdmin(
    input: { username: string; password: string; setupToken?: string },
    ctx: RequestContext,
  ): Promise<{ user: User; token: string; expiresAt: Date }> {
    if (!(await this.isSetupRequired()))
      throw new ConflictError('Setup has already been completed.', 'setup_complete');
    if (this.options.setupToken) {
      // Without a trustworthy client address, setup-token guessing is limited globally (pre-setup only).
      const limiterKey = `setup:${ctx.ip ?? 'global'}`;
      if (this.#loginLimiter.isBlocked(limiterKey)) throw new RateLimitedError();
      if (!input.setupToken || !safeEqual(input.setupToken, this.options.setupToken)) {
        this.#loginLimiter.recordFailure(limiterKey);
        throw new ForbiddenError('Setup token is missing or incorrect.');
      }
    }
    const username = normalizeUsername(input.username);
    const password = validateNewPassword(input.password);
    if (password.toLowerCase().includes(username)) {
      throw new ValidationError('Password must not contain the username.', {
        password: 'Must not contain the username.',
      });
    }
    const now = this.clock.now();
    const user = await this.users.createFirstAdmin({
      id: this.newId(),
      username,
      passwordHash: await hashPassword(password),
      role: 'admin',
      createdAt: now,
      lastLoginAt: now,
      disabledAt: null,
    });
    if (!user) throw new ConflictError('Setup has already been completed.', 'setup_complete');
    const { token, expiresAt } = await this.#createSession(user.id, ctx);
    await this.audit.record({
      action: 'auth.setup',
      actorUserId: user.id,
      entityType: 'user',
      entityId: user.id,
      meta: { username },
    });
    return { user, token, expiresAt };
  }

  async login(
    input: { username: string; password: string },
    ctx: RequestContext,
  ): Promise<{ user: User; token: string; expiresAt: Date }> {
    const username = typeof input.username === 'string' ? input.username.trim().toLowerCase() : '';
    const password = typeof input.password === 'string' ? input.password : '';
    // Unknown client addresses are not pooled into one bucket (that would let anyone lock out everyone);
    // the per-username bucket still applies.
    const keys = [`user:${username}`, ...(ctx.ip ? [`ip:${ctx.ip}`] : [])];
    if (keys.some((k) => this.#loginLimiter.isBlocked(k))) throw new RateLimitedError();

    const record =
      username && password.length <= PASSWORD_MAX_LENGTH ? await this.users.findByUsername(username) : null;
    const ok =
      record && !record.disabledAt
        ? await verifyPassword(record.passwordHash, password)
        : await verifyAgainstDummy(password);

    if (!ok || !record) {
      keys.forEach((k) => this.#loginLimiter.recordFailure(k));
      await this.audit.record({
        action: 'auth.login_failed',
        outcome: 'failure',
        meta: { username: username.slice(0, 64), ip: ctx.ip },
        knownSecrets: [password],
      });
      throw new AuthenticationError('Invalid username or password.');
    }
    this.#loginLimiter.reset(`user:${username}`);
    const now = this.clock.now();
    await this.users.recordLogin(record.id, now);
    const { token, expiresAt } = await this.#createSession(record.id, ctx);
    await this.audit.record({
      action: 'auth.login',
      actorUserId: record.id,
      entityType: 'user',
      entityId: record.id,
      meta: { ip: ctx.ip },
    });
    const { passwordHash: _omit, ...user } = record;
    return { user: { ...user, lastLoginAt: now }, token, expiresAt };
  }

  /** Resolves a cookie token to an active session, sliding its expiry. Returns null when invalid/expired. */
  async resolveSession(token: string | null | undefined): Promise<AuthenticatedSession | null> {
    if (!token || token.length > 128) return null;
    const id = hashSessionToken(token, this.options.sessionSecret);
    const now = this.clock.now();
    const found = await this.sessions.findActive(id, now);
    if (!found) return null;
    if (now.getTime() - found.session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      const expiresAt = new Date(now.getTime() + this.options.sessionTtlMs);
      await this.sessions.touch(id, now, expiresAt);
      found.session = { ...found.session, lastSeenAt: now, expiresAt };
    }
    return found;
  }

  async logout(token: string | null | undefined, actorUserId: string | null): Promise<void> {
    if (!token) return;
    await this.sessions.delete(hashSessionToken(token, this.options.sessionSecret));
    if (actorUserId) await this.audit.record({ action: 'auth.logout', actorUserId });
  }

  async purgeExpiredSessions(): Promise<number> {
    return this.sessions.deleteExpired(this.clock.now());
  }

  async #createSession(userId: string, ctx: RequestContext): Promise<{ token: string; expiresAt: Date }> {
    const token = generateSessionToken();
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + this.options.sessionTtlMs);
    await this.sessions.insert({
      id: hashSessionToken(token, this.options.sessionSecret),
      userId,
      createdAt: now,
      lastSeenAt: now,
      expiresAt,
      userAgent: ctx.userAgent?.slice(0, 256) ?? null,
    });
    return { token, expiresAt };
  }
}
