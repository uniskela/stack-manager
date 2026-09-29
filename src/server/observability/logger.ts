import type { LogLevel } from '@/server/config/config';
import { redact } from '@/server/security/redact';

/**
 * Structured JSON-lines logger. Every field passes through `redact`, so passwords, tokens,
 * cookies, ciphertext and credential-bearing URLs never reach stdout.
 */
export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogSink = (line: string, level: LogLevel) => void;

const defaultSink: LogSink = (line, level) => {
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(`${line}\n`);
};

export function createLogger(
  options: { level?: LogLevel; sink?: LogSink; bindings?: Record<string, unknown> } = {},
): Logger {
  const level = options.level ?? 'info';
  const sink = options.sink ?? defaultSink;
  const bindings = options.bindings ?? {};

  const emit = (lvl: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[lvl] < ORDER[level]) return;
    const record = redact({ ...bindings, ...fields }) as Record<string, unknown>;
    sink(JSON.stringify({ ts: new Date().toISOString(), level: lvl, msg: redact(msg), ...record }), lvl);
  };

  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (b) => createLogger({ level, sink, bindings: { ...bindings, ...b } }),
  };
}
