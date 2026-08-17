import {
  bindPoolMetrics,
  createAppServer,
  createLogger,
  createMetrics,
  initTracing,
  listen,
  loadOrExit,
  redactConfig,
  registerShutdown,
  RollingStats,
  sendJson,
  traceContext,
} from "@sample-app/platform";
import { loadConfig } from "./config.js";
import { createPool } from "./db/pool.js";
import { createQueueRepo } from "./db/queue.js";
import { startLoop } from "./loop.js";

const SERVICE = "settlement-worker";

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

const pool = createPool(config);
bindPoolMetrics(metrics, pool);
const queue = createQueueRepo(pool, { metrics, service: SERVICE });

const loop = startLoop({
  queue,
  metrics,
  logger,
  batchSize: config.batchSize,
  pollIntervalMs: config.pollIntervalMs,
  maxAttempts: config.maxAttempts,
  verbosePayload: config.verbosePayload,
});

const stats = new RollingStats();

const readiness = async (): Promise<{ ok: boolean; reason?: string }> => {
  try {
    await queue.ping();
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `db unreachable: ${err instanceof Error ? err.message : String(err)}` };
  }
};

// The worker serves no traffic; this is the admin port. /queue-stats is what chain-status
// aggregates — the worker owns the queue, so it is the only service that reports on it.
const server = createAppServer({
  port: config.port,
  service: SERVICE,
  metrics,
  logger,
  routes: [
    {
      method: "GET",
      pattern: "/queue-stats",
      handler: async ({ res }) => sendJson(res, 200, await queue.stats()),
    },
    {
      method: "GET",
      pattern: "/stats",
      handler: async ({ res }) => sendJson(res, 200, {
        service: SERVICE,
        version: config.serviceVersion,
        ...stats.snapshot(),
      }),
    },
  ],
  readyz: readiness,
});

registerShutdown({
  server,
  gracefulShutdownMs: config.gracefulShutdownMs,
  logger,
  hooks: [
    () => loop.stop(),
    () => pool.end(),
    ...(tracing ? [() => tracing.shutdown()] : []),
  ],
});

await listen(server, config.port, logger);