import {
  createApp,
  createHttpClient,
  createLogger,
  createMetrics,
  createSemaphore,
  faultInt,
  faultStr,
  initTracing,
  listen,
  loadOrExit,
  redactConfig,
  installShutdown,
  RollingStats,
  traceContext,
} from "@sample-app/platform";
import { FAULT_KNOBS, loadConfig } from "./config.js";
import { createRoutes } from "./routes.js";

const SERVICE = "storefront";

const config = loadOrExit(loadConfig);
const logger = createLogger({ service: SERVICE, version: config.serviceVersion, level: config.logLevel, traceContext });
const tracing = initTracing({
  service: SERVICE,
  version: config.serviceVersion,
  deploymentEnv: config.deploymentEnv,
  endpoint: config.otelEndpoint,
  logger,
});
const metrics = createMetrics({ service: SERVICE, version: config.serviceVersion, commit: config.serviceVersion });
logger.info("starting", { config: redactConfig({ ...config }) });

const client = createHttpClient({
  service: SERVICE,
  metrics,
  // Getters throughout: every dep below is captured once at boot, so a plain number could never
  // see a knob move. The client reads `deps.timeoutMs` on each request already.
  get timeoutMs() {
    return faultInt("GATEWAY_TIMEOUT_MS", config.gatewayTimeoutMs, { min: 1 });
  },
  // Attached by the client, not by each call site: a credential the gateway always requires
  // must not be something the next route someone adds can forget.
  ...(config.gatewayAuthToken ? { defaultHeaders: { authorization: `Bearer ${config.gatewayAuthToken}` } } : {}),
});
const stats = new RollingStats();
const semaphore = createSemaphore(() => faultInt("SSR_CONCURRENCY", config.ssrConcurrency, { min: 1 }));

const server = createApp({
  service: SERVICE,
  config,
  metrics,
  logger,
  stats,
  routes: createRoutes({
    client,
    logger,
    semaphore,
    selfStats: () => ({ service: SERVICE, version: config.serviceVersion, ...stats.snapshot() }),
    gatewayUrl: config.gatewayUrl,
    get assetVersion() {
      return faultStr("ASSET_VERSION", config.assetVersion);
    },
    assetCacheSeconds: config.assetCacheSeconds,
    loadgenUrl: config.loadgenUrl,
  }),
  faults: { knobs: FAULT_KNOBS, token: config.faultControlToken, ttlSeconds: config.faultTtlSeconds },
  readiness: async () => {
    try {
      await client.getJson("checkout-gateway", `${config.gatewayUrl}/healthz`, { timeoutMs: 1000 });
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: `checkout-gateway unreachable: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
});

installShutdown({
  server,
  timeoutMs: config.gracefulShutdownMs,
  logger,
  tasks: tracing ? [{ name: "tracing", run: () => tracing.shutdown() }] : [],
});

await listen(server, config.port, logger);