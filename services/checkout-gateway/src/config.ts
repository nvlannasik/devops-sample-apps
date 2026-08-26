import { loadCommonConfig, optInt, optStr, requireUrl, type CommonConfig, type EnvSource } from "@sample-app/platform";

export interface GatewayConfig extends CommonConfig {
  ordersApiUrl: string;
  workerUrl: string;
  downstreamTimeoutMs: number;
  cacheTtlSeconds: number;
  cacheMaxEntries: number;
  authToken: string | null;
}

export function loadConfig(env: EnvSource): GatewayConfig {
  return {
    ...loadCommonConfig(env),
    ordersApiUrl: requireUrl(env, "ORDERS_API_URL"),
    // chain-status aggregates the worker's /queue-stats, so the gateway needs its address.
    workerUrl: requireUrl(env, "WORKER_URL"),
    // Set below the upstream's real latency and the gateway gives up on a healthy service:
    // gateway spans fail while orders-api spans stay OK.
    downstreamTimeoutMs: optInt(env, "DOWNSTREAM_TIMEOUT_MS", 2000, { min: 1 }),
    cacheTtlSeconds: optInt(env, "CACHE_TTL_SECONDS", 30, { min: 0 }),
    cacheMaxEntries: optInt(env, "CACHE_MAX_ENTRIES", 1000, { min: 1 }),
    // Same value on the storefront. Unset leaves /api open — see the boot warning in index.ts.
    authToken: optStr(env, "GATEWAY_AUTH_TOKEN", "") || null,
  };
}
