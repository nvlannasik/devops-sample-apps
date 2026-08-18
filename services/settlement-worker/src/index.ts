import {
  bindPoolMetrics,
  createApp,
  createLogger,
  createMetrics,
  initTracing,
  listen,
  loadOrExit,
  redactConfig,
  installShutdown,
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

const readiness = async (): Promise<{ ok: boolean; detail?: string }> => {
  try {
    await queue.ping();
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: `db unreachable: ${err instanceof Error ? err.message : String(err)}` };
  }
};

// The worker serves no traffic; this is the admin port. /queue-stats is what chain-status
// aggregates — the worker owns the queue, so it is the only service that reports on it.
// /stats comes from createApp, like every other service.
const server = createApp({
  service: SERVICE,
  config,
  metrics,
  logger,
  stats,
  routes: [
    {
      method: "GET",
      pattern: "/queue-stats",
      handler: async ({ res }) => sendJson(res, 200, await queue.stats()),
    },
  ],
  readiness,
});

installShutdown({
  server,
  timeoutMs: config.gracefulShutdownMs,
  logger,
  tasks: [
    { name: "settle loop", run: () => loop.stop() },
    { name: "db pool", run: () => pool.end() },
    ...(tracing ? [{ name: "tracing", run: () => tracing.shutdown() }] : []),
  ],
});

await listen(server, config.port, logger);