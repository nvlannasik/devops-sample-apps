import {
  loadCommonConfig,
  optInt,
  optStr,
  requireUrl,
  type CommonConfig,
  type EnvSource,
  type FaultKnob,
} from "@sample-app/platform";

/**
 * The knobs this service can arm at runtime, from `docs/DEPLOYMENT_CONTRACT.md §3`.
 *
 * `SSR_CONCURRENCY` needs the generator's concurrency above 1 before it moves anything — one
 * worker is one in-flight request and never makes a serialised queue, no matter the rps. The
 * control page says so next to the button, because a knob that looks broken is worse than none.
 */
export const FAULT_KNOBS: FaultKnob[] = [
  {
    key: "GATEWAY_TIMEOUT_MS",
    label: "Gateway timeout 50ms",
    armed: "50",
    note: "the storefront gives up before checkout-gateway can answer: a 504 storm at the edge with every tier below it healthy",
  },
  {
    key: "SSR_CONCURRENCY",
    label: "SSR concurrency 1",
    armed: "1",
    note: "requests queue at the edge; TTFB explodes while no downstream service slows down. Needs generator concurrency above 1",
  },
  {
    key: "ASSET_VERSION",
    label: "Stale asset version",
    armed: "stale",
    note: "every page links a stylesheet that 404s: the product is visibly broken and every metric stays green",
  },
];

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