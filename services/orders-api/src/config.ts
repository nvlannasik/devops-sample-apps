import {
  ConfigError,
  loadCommonConfig,
  loadDbConfig,
  optBool,
  optInt,
  type CommonConfig,
  type DbConfig,
  type EnvSource,
  type FaultKnob,
} from "@sample-app/platform";

/**
 * The knobs this service can arm at runtime, from `docs/DEPLOYMENT_CONTRACT.md §3`.
 *
 * `DB_POOL_MAX` and `DB_STATEMENT_TIMEOUT_MS` are absent on purpose: both are read once when the
 * pool is built, so a runtime override would show a knob as armed while changing nothing. They
 * stay environment variables and a rollout.
 */
export const FAULT_KNOBS: FaultKnob[] = [
  {
    key: "ORDER_RESPONSE_VERSION",
    label: "Order response v2",
    armed: "2",
    note: "amount_cents becomes a nested object; checkout-gateway fails to parse it and the storefront serves 502",
  },
];

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