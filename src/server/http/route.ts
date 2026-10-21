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

export type AuthMode = 'public' | 'user' | 'signed-webhook';

export interface RouteContext<P, B, A extends AuthMode> {
  req: Request;
  params: P;
  body: B;
  rawBody: Uint8Array;
  container: Container;
  session: A extends 'user' ? AuthenticatedSession : AuthenticatedSession | null;
  requestContext: RequestContext;
  sessionToken: string | null;
}

export interface RouteOptions<B, A extends AuthMode> {
  /** Default-deny: every route must choose. Public browser routes retain CSRF checks; signed-webhook ingress authenticates its raw body. */
  auth: A;
  body?: ZodType<B>;
  /** Request body cap in bytes (default 64 KiB). Raise only for routes that carry file content. */
  maxBodyBytes?: number;
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
  return (await readBytesWithLimit(req, limit)).toString('utf8');
}

export async function readBytesWithLimit(req: Request, limit: number): Promise<Buffer> {
  const declared = req.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw tooLarge();
  if (!req.body) return Buffer.alloc(0);
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
  return Buffer.concat(chunks);
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

      const signedWebhook = options.auth === 'signed-webhook';
      if (signedWebhook && req.method !== 'POST')
        return json(
          { error: { code: 'method_not_allowed', message: 'Expected POST.' } },
          { status: 405, headers: { Allow: 'POST' } },
        );
      if (!signedWebhook && isMutation(req.method) && !isSameOrigin(req, config)) {
        throw new ForbiddenError('Cross-origin request rejected.');
      }

      const sessionToken = signedWebhook
        ? null
        : (parseCookies(req.headers.get('cookie')).get(sessionCookieName(config)) ?? null);
      const session = signedWebhook ? null : await container.auth.resolveSession(sessionToken);
      if (options.auth === 'user' && !session) throw new AuthenticationError();

      const params = ((await segment?.params) ?? {}) as P;
      const requestContext = requestContextFrom(req, config.trustedProxyHops);
      if (signedWebhook) {
        container.gitWebhooks.limitRequests(requestContext.ip);
      }

      const rawBody = signedWebhook
        ? await readSignedWebhookBody(req, options.body !== undefined)
        : new Uint8Array();
      const body = options.body
        ? await readJsonBody(req, options.body, options.maxBodyBytes ?? MAX_BODY_BYTES)
        : (undefined as B);

      const result = await handler({
        req,
        rawBody,
        params,
        body,
        container,
        session: session as RouteContext<P, B, A>['session'],
        requestContext,
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

async function readSignedWebhookBody(req: Request, hasBodySchema: boolean): Promise<Uint8Array> {
  if (hasBodySchema) throw new Error('Signed webhook bodies must be authenticated before parsing.');
  const type = req.headers.get('content-type') ?? '';
  if (
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(type.trim()) ||
    (req.headers.get('content-encoding') ?? 'identity') !== 'identity'
  ) {
    throw new AppError(415, 'unsupported_media_type', 'Expected uncompressed UTF-8 application/json.');
  }
  return readBytesWithLimit(req, 1024 * 1024);
}

async function readJsonBody<B>(req: Request, schema: ZodType<B>, maxBytes: number): Promise<B> {
  const contentType = req.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new AppError(415, 'unsupported_media_type', 'Expected application/json.');
  }
  const text = await readBodyWithLimit(req, maxBytes);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ValidationError('Malformed JSON body.');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ValidationError('Invalid request.', zodFields(parsed.error));
  return parsed.data;
}
