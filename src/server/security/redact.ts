/**
 * Redaction utilities shared by the logger, audit trail and job payloads.
 *
 * Redaction is the default: callers opt *out* by choosing non-sensitive key names and values,
 * never *in*. Keys that look sensitive are replaced wholesale; string values are scrubbed for
 * credential-shaped content (embedded URL credentials, bearer tokens, forge PAT prefixes,
 * private keys, secret query parameters and webhook tokens).
 */

export const REDACTED = '[REDACTED]';

const SENSITIVE_KEY =
  /(pass(word|phrase|wd)?|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|authorization|auth[-_]?header|cookie|credential|ciphertext|nonce|signature|session|hash)$|^(authorization|cookie|set-cookie|x-api-key|x-auth-token)$/i;

const STRING_PATTERNS: Array<[RegExp, string]> = [
  // PEM private keys (keep first so the body is not partially matched by later rules).
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, REDACTED],
  // Credentials embedded in URLs: scheme://user:pass@host → scheme://[REDACTED]@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/gi, `$1${REDACTED}@`],
  // Authorization header values.
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{4,}/g, `$1 ${REDACTED}`],
  // Well-known forge / SaaS token prefixes.
  [
    /\b(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g,
    REDACTED,
  ],
  // Secret-looking query string parameters.
  [
    /([?&](?:access_token|token|secret|key|api_key|apikey|password|passwd|sig|signature|code)=)[^&#\s]+/gi,
    `$1${REDACTED}`,
  ],
  // Webhook URLs whose path segment is the secret (Portainer, generic deploy hooks).
  [/(\/webhooks?\/)[A-Za-z0-9_-]{8,}/gi, `$1${REDACTED}`],
];

export interface RedactOptions {
  /** Literal secret values known to the caller; scrubbed anywhere they appear. */
  secrets?: ReadonlyArray<string | null | undefined>;
  /** Max nesting depth before values are elided. */
  maxDepth?: number;
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

export function scrubString(input: string, options: RedactOptions = {}): string {
  let out = input;
  for (const secret of options.secrets ?? []) {
    if (secret && secret.length >= 4) out = out.split(secret).join(REDACTED);
  }
  for (const [pattern, replacement] of STRING_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** Deep-copies `value`, redacting sensitive keys and scrubbing strings. Never mutates input. */
export function redact<T = unknown>(value: T, options: RedactOptions = {}): unknown {
  const maxDepth = options.maxDepth ?? 8;
  const seen = new WeakSet<object>();

  const walk = (v: unknown, depth: number): unknown => {
    if (v === null || v === undefined) return v;
    if (typeof v === 'string') return scrubString(v, options);
    if (typeof v === 'number' || typeof v === 'boolean') return v;
    if (typeof v === 'bigint') return v.toString();
    if (typeof v === 'function' || typeof v === 'symbol') return undefined;
    if (Buffer.isBuffer(v) || v instanceof Uint8Array) return REDACTED;
    if (v instanceof Date) return v.toISOString();
    if (v instanceof URL) return scrubString(v.toString(), options);
    if (v instanceof Error) {
      return { name: v.name, message: scrubString(v.message, options) };
    }
    if (typeof v !== 'object') return undefined;
    if (seen.has(v)) return '[Circular]';
    if (depth >= maxDepth) return '[Truncated]';
    seen.add(v);
    if (Array.isArray(v)) return v.map((item) => walk(item, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
      out[k] =
        isSensitiveKey(k) && child !== null && child !== undefined && child !== ''
          ? REDACTED
          : walk(child, depth + 1);
    }
    return out;
  };

  return walk(value, 0);
}

/** Redacts an error into a short, safe message suitable for persistence (e.g. Job.lastError). */
export function safeErrorMessage(error: unknown, options: RedactOptions = {}, maxLength = 500): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const scrubbed = scrubString(raw, options);
  return scrubbed.length > maxLength ? `${scrubbed.slice(0, maxLength)}…` : scrubbed;
}
