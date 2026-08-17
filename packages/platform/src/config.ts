export type EnvSource = Record<string, string | undefined>;
export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

export class ConfigError extends Error {
  readonly key: string;
  constructor(key: string, reason: string) {
    super(`invalid config: ${key} ${reason}`);
    this.name = "ConfigError";
    this.key = key;
  }
}

export function requireStr(env: EnvSource, key: string): string {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") throw new ConfigError(key, "is required");
  return raw.trim();
}

export function optStr(env: EnvSource, key: string, def: string): string {
  const raw = env[key];
  return raw === undefined || raw.trim() === "" ? def : raw.trim();
}

export function optInt(
  env: EnvSource,
  key: string,
  def: number,
  opts: { min?: number; max?: number } = {},
): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return def;
  const n = Number(raw.trim());
  if (!Number.isInteger(n)) throw new ConfigError(key, `must be an integer, got "${raw}"`);
  if (opts.min !== undefined && n < opts.min) throw new ConfigError(key, `must be >= ${opts.min}, got ${n}`);
  if (opts.max !== undefined && n > opts.max) throw new ConfigError(key, `must be <= ${opts.max}, got ${n}`);
  return n;
}

export function optNumber(
  env: EnvSource,
  key: string,
  fallback: number,
  bounds: { min?: number; max?: number } = {},
): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new ConfigError(key, `must be a number, got ${JSON.stringify(raw)}`);
  if (bounds.min !== undefined && value < bounds.min) throw new ConfigError(key, `must be >= ${bounds.min}, got ${value}`);
  if (bounds.max !== undefined && value > bounds.max) throw new ConfigError(key, `must be <= ${bounds.max}, got ${value}`);
  return value;
}

export function optBool(env: EnvSource, key: string, def: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return def;
  const v = raw.trim().toLowerCase();
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  throw new ConfigError(key, `must be true or false, got "${raw}"`);
}

export function requireUrl(env: EnvSource, key: string): string {
  const raw = requireStr(env, key);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(key, `must be an absolute URL, got "${raw}"`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError(key, `must use http or https, got "${url.protocol}"`);
  }
  return raw.replace(/\/+$/, "");
}

export function optLogLevel(env: EnvSource, key: string, def: LogLevel): LogLevel {
  const raw = optStr(env, key, def).toLowerCase();
  if (!LOG_LEVELS.includes(raw as LogLevel)) {
    throw new ConfigError(key, `must be one of ${LOG_LEVELS.join("|")}, got "${raw}"`);
  }
  return raw as LogLevel;
}

export interface CommonConfig {
  nodeEnv: string;
  port: number;
  logLevel: LogLevel;
  serviceVersion: string;
  deploymentEnv: string;
  otelEndpoint: string | null;
  gracefulShutdownMs: number;
}

export function loadCommonConfig(env: EnvSource): CommonConfig {
  return {
    nodeEnv: optStr(env, "NODE_ENV", "production"),
    port: optInt(env, "PORT", 3000, { min: 1, max: 65535 }),
    logLevel: optLogLevel(env, "LOG_LEVEL", "info"),
    // Injected at build time from the git SHA; "dev" keeps local runs and tests working.
    serviceVersion: optStr(env, "SERVICE_VERSION", "dev"),
    deploymentEnv: optStr(env, "DEPLOYMENT_ENV", "dev"),
    otelEndpoint: optStr(env, "OTEL_EXPORTER_OTLP_ENDPOINT", "") || null,
    gracefulShutdownMs: optInt(env, "GRACEFUL_SHUTDOWN_MS", 10000, { min: 0 }),
  };
}

const SECRET_KEY = /pass|secret|token/i;

/**
 * The resolved config is logged once at boot so a fault knob is findable in Loki as well as
 * in k8s_describe_pod. A blanked-out DATABASE_URL would defeat that, so URLs keep their host
 * and database and lose only the password.
 */
export function redactValue(key: string, value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (SECRET_KEY.test(key)) return "***";
  try {
    const url = new URL(value);
    if (url.password) {
      url.password = "***";
      return url.toString();
    }
  } catch {
    // not a URL; fall through
  }
  return value;
}

export function redactConfig(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) out[k] = redactValue(k, v);
  return out;
}

export interface LoadOrExitIo {
  write?: (line: string) => void;
  exit?: (code: number) => never;
}

/** Fail loudly at boot: a bad value prints its reason on stdout and exits non-zero. */
export function loadOrExit<T>(
  load: (env: EnvSource) => T,
  env: EnvSource = process.env,
  io: LoadOrExitIo = {},
): T {
  const write = io.write ?? ((line: string) => void process.stdout.write(line));
  const exit = io.exit ?? ((code: number) => process.exit(code));
  try {
    return load(env);
  } catch (err) {
    write(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        msg: "config error, refusing to start",
        err: { type: err instanceof Error ? err.name : typeof err, msg: err instanceof Error ? err.message : String(err) },
      }) + "\n",
    );
    return exit(1);
  }
}
