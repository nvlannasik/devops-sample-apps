import {
  loadCommonConfig,
  loadDbConfig,
  optBool,
  optInt,
  type CommonConfig,
  type DbConfig,
  type EnvSource,
} from "@sample-app/platform";

export interface WorkerConfig extends CommonConfig {
  db: DbConfig;
  dbPoolMax: number;
  batchSize: number;
  pollIntervalMs: number;
  maxAttempts: number;
  verbosePayload: boolean;
}

export function loadConfig(env: EnvSource): WorkerConfig {
  return {
    ...loadCommonConfig(env),
    db: loadDbConfig(env),
    dbPoolMax: optInt(env, "DB_POOL_MAX", 5, { min: 1, max: 1000 }),
    // Every claimed row, order payload included, is held in memory for the batch's lifetime.
    // A large value genuinely grows the working set until the OOM killer intervenes.
    batchSize: optInt(env, "SETTLEMENT_BATCH_SIZE", 50, { min: 1 }),
    // Raise it past the arrival rate and the worker falls behind for real.
    pollIntervalMs: optInt(env, "SETTLEMENT_POLL_INTERVAL_MS", 1000, { min: 0 }),
    maxAttempts: optInt(env, "SETTLEMENT_MAX_ATTEMPTS", 3, { min: 1 }),
    verbosePayload: optBool(env, "VERBOSE_PAYLOAD", false),
  };
}