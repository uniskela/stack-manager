/**
 * Domain/application errors. Messages are safe to show to an authenticated operator and must
 * never contain secrets. The HTTP layer maps `status` directly.
 */
export type FieldErrors = Record<string, string>;

/**
 * Brand used instead of `instanceof` at the HTTP boundary: Next.js compiles instrumentation (where the
 * container is created) and route bundles separately, so the same class can exist twice at runtime.
 */
const APP_ERROR = Symbol.for('stack-manager.AppError');

export function isAppError(error: unknown): error is AppError {
  return (
    typeof error === 'object' && error !== null && (error as Record<symbol, unknown>)[APP_ERROR] === true
  );
}

export class AppError extends Error {
  readonly [APP_ERROR] = true;
  readonly status: number;
  readonly code: string;
  readonly fields: FieldErrors | undefined;

  constructor(status: number, code: string, message: string, fields?: FieldErrors) {
    super(message);
    this.name = new.target.name;
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, fields?: FieldErrors) {
    super(400, 'validation_failed', message, fields);
  }
}

export class AuthenticationError extends AppError {
  constructor(message = 'Authentication required.') {
    super(401, 'unauthenticated', message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden.') {
    super(403, 'forbidden', message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found.') {
    super(404, 'not_found', message);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, code = 'conflict') {
    super(409, code, message);
  }
}

export class RateLimitedError extends AppError {
  constructor(message = 'Too many attempts. Try again later.') {
    super(429, 'rate_limited', message);
  }
}
