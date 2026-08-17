import type { OrderV1 } from "@sample-app/contracts";
import {
  bindPoolMetrics as _unused,
  createAppServer,
  createHttpClient,
  createLogger,
  createMetrics,
  initTracing,
  listen,
  loadOrExit,
  redactConfig,
  registerShutdown,
  RollingStats,
  traceContext,
} from "@sample-app/platform";
import { loadConfig } from "./config.js";
import { createCache } from "./cache.js";
import { createRoutes } from "./routes.js";

const SERVICE = "checkout-gateway";

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

const client = createHttpClient({ service: SERVICE, metrics, timeoutMs: config.downstreamTimeoutMs });
const stats = new RollingStats();
const cache = createCache<OrderV1>({
  ttlSeconds: config.cacheTtlSeconds,
  maxEntries: config.cacheMaxEntries,
});

// Readiness checks the downstream (spec §8): a gateway that cannot reach orders-api serves
// nothing useful. It probes /healthz — orders-api's own readiness must not chain into ours.
const readiness = async (): Promise<{ ok: boolean; reason?: string }> => {
  try {
    await client.getJson("orders-api", `${config.ordersApiUrl}/healthz`, { timeoutMs: 1000 });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `orders-api unreachable: ${err instanceof Error ? err.message : String(err)}` };
  }
};

const server = createAppServer({
  port: config.port,
  service: SERVICE,
  metrics,
  logger,
  routes: createRoutes({
    client,
    logger,
    metrics,
    cache,
    selfStats: () => ({ service: SERVICE, version: config.serviceVersion, ...stats.snapshot() }),
    ordersApiUrl: config.ordersApiUrl,
    workerUrl: config.workerUrl,
  }),
  readyz: readiness,
});

registerShutdown({
  server,
  gracefulShutdownMs: config.gracefulShutdownMs,
  logger,
  hooks: tracing ? [() => tracing.shutdown()] : [],
});

await listen(server, config.port, logger);
