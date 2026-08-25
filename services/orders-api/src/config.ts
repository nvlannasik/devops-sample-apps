import {
  ConfigError,
  loadCommonConfig,
  loadDbConfig,
  optBool,
  optInt,
  type CommonConfig,
  type DbConfig,
  type EnvSource,
} from "@sample-app/platform";

export interface OrdersApiConfig extends CommonConfig {
  db: DbConfig;
  dbPoolMax: number;
  dbStatementTimeoutMs: number;
  migrationRequired: boolean;
  orderResponseVersion: 1 | 2;
  livenessChecksDb: boolean;
}

export function loadConfig(env: EnvSource): OrdersApiConfig {
  const version = optInt(env, "ORDER_RESPONSE_VERSION", 1, { min: 1, max: 2 });
  if (version !== 1 && version !== 2) throw new ConfigError("ORDER_RESPONSE_VERSION", "must be 1 or 2");

  const common = loadCommonConfig(env);
  return {
    ...common,
    db: loadDbConfig(env),
    dbPoolMax: optInt(env, "DB_POOL_MAX", 10, { min: 1 }),
    dbStatementTimeoutMs: optInt(env, "DB_STATEMENT_TIMEOUT_MS", 5000, { min: 0 }),
    migrationRequired: optBool(env, "MIGRATION_REQUIRED", true),
    orderResponseVersion: version as 1 | 2,
    livenessChecksDb: optBool(env, "LIVENESS_CHECKS_DB", false),
  };
}