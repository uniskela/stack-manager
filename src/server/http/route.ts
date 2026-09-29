import 'server-only';
import { z, type ZodType } from 'zod';
import type { AuthenticatedSession, RequestContext } from '@/server/application/auth-service';
import { getContainer, type Container } from '@/server/container';
import {
  AppError,
  AuthenticationError,
  ForbiddenError,
  isAppError,
  ValidationError,
} from '@/server/domain/errors';
import { clientIpFrom } from './client-ip';
import { parseCookies, sessionCookieName } from './cookies';
import { isMutation, isSameOrigin } from './origin';

export type AuthMode = 'public' | 'user';

export interface RouteContext<P, B, A extends AuthMode> {
  req: Request;
  params: P;
  body: B;
  container: Container;
  session: A extends 'user' ? AuthenticatedSession : AuthenticatedSession | null;
  requestContext: RequestContext;
  sessionToken: string | null;
}

export interface RouteOptions<B, A extends AuthMode> {
  /** Default-deny: every route must choose. Only setup, login and health are public. */
  auth: A;
  body?: ZodType<B>;
}

type NextSegment = { params: Promise<Record<string, string | string[]>> };

const MAX_BODY_BYTES = 64 * 1024;

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function errorResponse(error: unknown, container?: Container): Response {
  if (isAppError(error)) {
    if (error.status >= 500) container?.logger.error('request failed', { code: error.code, error });
    return json(
      { error: { code: error.code, message: error.message, fields: error.fields } },
      { status: error.status },
    );
  }
  container?.logger.error('unhandled request error', { error });
  return json({ error: { code: 'internal_error', message: 'Something went wrong.' } }, { status: 500 });
}

export function requestContextFrom(req: Request, trustedProxyHops: number): RequestContext {
  return {
    ip: clientIpFrom(req.headers, trustedProxyHops),
    userAgent: req.headers.get('user-agent'),
  };
}

const tooLarge = () => new AppError(413, 'payload_too_large', 'Request body too large.');

/**
 * Reads the body as UTF-8 while enforcing `limit`: a declared Content-Length over the cap is rejected
 * before reading, and streaming stops as soon as the accumulated size exceeds it.
 */
export async function readBodyWithLimit(req: Request, limit: number): Promise<string> {
  const declared = req.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw tooLarge();
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Wraps a route handler with: authentication (default-deny), same-origin checks on mutations,
 * JSON-only bodies with a size cap, schema validation and safe error mapping.
 */
export function defineRoute<P = Record<string, string>, B = undefined, A extends AuthMode = 'user'>(
  options: RouteOptions<B, A>,
  handler: (ctx: RouteContext<P, B, A>) => Promise<Response | unknown>,
) {
  const wrapped = async (req: Request, segment?: NextSegment): Promise<Response> => {
    let container: Container | undefined;
    try {
      container = getContainer();
      const { config } = container;

      if (isMutation(req.method) && !isSameOrigin(req, config)) {
        throw new ForbiddenError('Cross-origin request rejected.');
      }

      const sessionToken = parseCookies(req.headers.get('cookie')).get(sessionCookieName(config)) ?? null;
      const session = await container.auth.resolveSession(sessionToken);
      if (options.auth === 'user' && !session) throw new AuthenticationError();

      let body = undefined as B;
      if (options.body) {
        const contentType = req.headers.get('content-type') ?? '';
        if (!contentType.toLowerCase().startsWith('application/json')) {
          throw new AppError(415, 'unsupported_media_type', 'Expected application/json.');
        }
        const text = await readBodyWithLimit(req, MAX_BODY_BYTES);
        let raw: unknown;
        try {
          raw = JSON.parse(text);
        } catch {
          throw new ValidationError('Malformed JSON body.');
        }
        const parsed = options.body.safeParse(raw);
        if (!parsed.success) throw new ValidationError('Invalid request.', zodFields(parsed.error));
        body = parsed.data;
      }

      const params = ((await segment?.params) ?? {}) as P;
      const result = await handler({
        req,
        params,
        body,
        container,
        session: session as RouteContext<P, B, A>['session'],
        requestContext: requestContextFrom(req, config.trustedProxyHops),
        sessionToken,
      });
      return result instanceof Response ? result : json(result ?? { ok: true });
    } catch (error) {
      return errorResponse(error, container);
    }
  };
  // Marker used by the route-coverage test to prove every API route goes through this wrapper.
  Object.defineProperty(wrapped, '__stackManagerRoute', { value: options.auth });
  return wrapped;
}

function zodFields(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_';
    fields[key] ??= issue.message;
  }
  return fields;
}
