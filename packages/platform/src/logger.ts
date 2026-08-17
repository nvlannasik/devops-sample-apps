import type { LogLevel } from "./config.js";

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function serializeError(err: unknown): { type: string; msg: string; stack?: string } {
  if (err instanceof Error) {
    return { type: err.name, msg: err.message, ...(err.stack ? { stack: err.stack } : {}) };
  }
  return { type: typeof err, msg: String(err) };
}

export interface LoggerOptions {
  service: string;
  version: string;
  level: LogLevel;
  write?: (line: string) => void;
  /** Supplies trace_id/span_id from the active span, when tracing is enabled. */
  traceContext?: () => { trace_id?: string; span_id?: string };
  now?: () => Date;
}

/** One JSON object per line, to stdout, never to a file (12-factor XI). */
export function createLogger(opts: LoggerOptions): Logger {
  const write = opts.write ?? ((line: string) => void process.stdout.write(line));
  const now = opts.now ?? (() => new Date());
  const traceContext = opts.traceContext ?? (() => ({}));
  const min = RANK[opts.level];

  const emit = (level: LogLevel, msg: string, fields?: LogFields): void => {
    if (RANK[level] < min) return;
    const { err, ...rest } = fields ?? {};
    const line: Record<string, unknown> = {
      ts: now().toISOString(),
      level,
      service: opts.service,
      version: opts.version,
      msg,
      ...traceContext(),
      ...rest,
    };
    if (err !== undefined) line.err = serializeError(err);
    write(JSON.stringify(line) + "\n");
  };

  return {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
  };
}
