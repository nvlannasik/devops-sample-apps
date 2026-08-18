import {
  createApp,
  createHttpClient,
  createLogger,
  createMetrics,
  createSemaphore,
  initTracing,
  listen,
  loadOrExit,
  redactConfig,
  installShutdown,
  RollingStats,
  traceContext,
} from "@sample-app/platform";
import { loadConfig } from "./config.js";
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

const client = createHttpClient({ service: SERVICE, metrics, timeoutMs: config.gatewayTimeoutMs });
const stats = new RollingStats();
const semaphore = createSemaphore(config.ssrConcurrency);

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
    assetVersion: config.assetVersion,
    assetCacheSeconds: config.assetCacheSeconds,
  }),
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