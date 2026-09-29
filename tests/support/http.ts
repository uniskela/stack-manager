type Handler = (req: Request, segment?: { params: Promise<Record<string, string>> }) => Promise<Response>;

export const ORIGIN = 'http://stack.test';

export interface CallOptions {
  method?: string;
  path?: string;
  body?: unknown;
  cookie?: string | null;
  origin?: string | null;
  params?: Record<string, string>;
  headers?: Record<string, string>;
}

/** Invokes a Next.js route handler directly with a synthetic Request. */
export async function call(handler: Handler, options: CallOptions = {}) {
  const headers = new Headers(options.headers);
  headers.set('host', 'stack.test');
  if (options.origin !== null) headers.set('origin', options.origin ?? ORIGIN);
  if (options.cookie) headers.set('cookie', options.cookie);
  if (options.body !== undefined && !headers.has('content-type'))
    headers.set('content-type', 'application/json');
  const req = new Request(`${ORIGIN}${options.path ?? '/api/test'}`, {
    method: options.method ?? 'GET',
    headers,
    body:
      options.body === undefined
        ? undefined
        : typeof options.body === 'string'
          ? options.body
          : JSON.stringify(options.body),
  });
  const res = await handler(req, { params: Promise.resolve(options.params ?? {}) });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, headers: res.headers, json: json as any, text };
}

/** Extracts "name=value" from a Set-Cookie header for reuse in the Cookie header. */
export function cookieFrom(res: { headers: Headers }): string {
  const set = res.headers.get('set-cookie');
  if (!set) throw new Error('no Set-Cookie header');
  return set.split(';')[0]!;
}
