import { loadCommonConfig, optInt, optStr, requireUrl, type CommonConfig, type EnvSource } from "@sample-app/platform";

export interface StorefrontConfig extends CommonConfig {
  gatewayUrl: string;
  gatewayTimeoutMs: number;
  ssrConcurrency: number;
  assetCacheSeconds: number;
  assetVersion: string;
  /**
   * Where the header's "Load" button points. It is followed by a BROWSER, so it has to be an
   * address the browser can reach — a public hostname or a port-forward — never the in-cluster
   * Service DNS. Unset hides the button, which is the right default for a storefront that is
   * not currently being demoed.
   */
  loadgenUrl: string | null;
  /** Presented as a bearer token on every checkout-gateway call. Same value on both sides. */
  gatewayAuthToken: string | null;
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
    loadgenUrl: optStr(env, "LOADGEN_UI_URL", "") || null,
    // The same value the gateway reads. Unset means the gateway is open, which a local stack is.
    gatewayAuthToken: optStr(env, "GATEWAY_AUTH_TOKEN", "") || null,
  };
}