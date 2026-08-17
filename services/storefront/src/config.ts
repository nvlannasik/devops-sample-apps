import { loadCommonConfig, optInt, optStr, requireUrl, type CommonConfig, type EnvSource } from "@sample-app/platform";

export interface StorefrontConfig extends CommonConfig {
  gatewayUrl: string;
  gatewayTimeoutMs: number;
  ssrConcurrency: number;
  assetCacheSeconds: number;
  assetVersion: string;
}

export function loadConfig(env: EnvSource): StorefrontConfig {
  const common = loadCommonConfig(env);
  return {
    ...common,
    gatewayUrl: requireUrl(env, "GATEWAY_URL"),
    gatewayTimeoutMs: optInt(env, "GATEWAY_TIMEOUT_MS", 2000, { min: 1 }),
    ssrConcurrency: optInt(env, "SSR_CONCURRENCY", 32, { min: 1 }),
    assetCacheSeconds: optInt(env, "ASSET_CACHE_SECONDS", 3600, { min: 0 }),
    assetVersion: optStr(env, "ASSET_VERSION", common.serviceVersion),
  };
}