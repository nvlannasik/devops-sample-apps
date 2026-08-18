import {
  bindPoolMetrics,
  createApp,
  createLogger,
  createMetrics,
  initTracing,
  listen,
  installShutdown,
  loadOrExit,
  redactConfig,
  RollingStats,
  traceContext,
} from "@sample-app/platform";
import { loadConfig } from "./config.js";
import { createPool } from "./db/pool.js";
import { createOrdersRepo } from "./db/orders-repo.js";
import { assertSchemaCurrent } from "./db/migrate.js";
import { createRoutes } from "./routes.js";

const SERVICE = "orders-api";

const config = loadOrExit(loadConfig);
const logger = createLogger({
  service: SERVICE,
  version: config.serviceVersion,
  level: config.logLevel,
  traceContext,
});
const tracing = initTracing({
  service: SERVICE,
  version: config.serviceVersion,
  deploymentEnv: config.deploymentEnv,
  endpoint: config.otelEndpoint,
  logger,
});
const metrics = createMetrics({ service: SERVICE, version: config.serviceVersion, commit: config.serviceVersion });

// Logged once at boot so the running fault knob is findable in Loki, not only in the pod spec.
logger.info("starting", { config: redactConfig({ ...config }) });

const pool = createPool(config);
bindPoolMetrics(metrics, pool);
const repo = createOrdersRepo(pool, { metrics, service: SERVICE });

if (config.migrationRequired) {
  try {
    await assertSchemaCurrent(pool, logger);
  } catch (err) {
    logger.error("refusing to start against an out-of-date schema", { err });
    process.exit(1);
  }
}

const stats = new RollingStats();

const readiness = async (): Promise<{ ok: boolean; detail?: string }> => {
  if (pool.waitingCount > 0 && pool.idleCount === 0) {
    return { ok: false, detail: `db pool exhausted: ${pool.waitingCount} waiting` };
  }
  try {
    await repo.ping();
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: `db unreachable: ${err instanceof Error ? err.message : String(err)}` };
  }
};

const server = createApp({
  service: SERVICE,
  config,
  logger,
  metrics,
  stats,
  routes: createRoutes({ repo, logger, orderResponseVersion: config.orderResponseVersion }),
  readiness,
  // LIVENESS_CHECKS_DB=true makes the kubelet restart healthy pods when the database
  // stalls — a cluster-wide restart storm whose symptom points nowhere near its cause.
  liveness: config.livenessChecksDb ? readiness : undefined,
});

installShutdown({
  server,
  timeoutMs: config.gracefulShutdownMs,
  logger,
  tasks: [
    { name: "db pool", run: () => pool.end() },
    ...(tracing ? [{ name: "tracing", run: () => tracing.shutdown() }] : []),
  ],
});

await listen(server, config.port, logger);