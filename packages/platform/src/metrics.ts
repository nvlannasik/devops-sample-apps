import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

/** Seconds. Every duration histogram in the contract shares these. */
export const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/** Rows per settlement claim — not seconds, so it needs its own scale. */
export const BATCH_SIZE_BUCKETS = [1, 5, 10, 25, 50, 100, 250, 500, 1000];

export interface Metrics {
  registry: Registry;
  service: string;
  httpServerRequests: Counter<string>;
  httpServerDuration: Histogram<string>;
  httpClientRequests: Counter<string>;
  httpClientDuration: Histogram<string>;
  dbPoolConnections: Gauge<string>;
  dbQueryDuration: Histogram<string>;
  cacheRequests: Counter<string>;
  queueDepth: Gauge<string>;
  queueOldestJobAge: Gauge<string>;
  settlementJobs: Counter<string>;
  settlementBatchSize: Histogram<string>;
  buildInfo: Gauge<string>;
}

export function createMetrics(opts: { service: string; version: string; commit: string }): Metrics {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  const metrics: Metrics = {
    registry,
    service: opts.service,
    httpServerRequests: new Counter({
      name: "http_server_requests_total",
      help: "HTTP requests served, by templated route and status",
      labelNames: ["service", "method", "route", "status"],
      registers: [registry],
    }),
    httpServerDuration: new Histogram({
      name: "http_server_request_duration_seconds",
      help: "HTTP server request duration in seconds",
      labelNames: ["service", "method", "route"],
      buckets: DURATION_BUCKETS,
      registers: [registry],
    }),
    httpClientRequests: new Counter({
      name: "http_client_requests_total",
      help: "Outbound HTTP requests, by logical peer and status",
      labelNames: ["service", "peer", "status"],
      registers: [registry],
    }),
    httpClientDuration: new Histogram({
      name: "http_client_request_duration_seconds",
      help: "Outbound HTTP request duration in seconds",
      labelNames: ["service", "peer"],
      buckets: DURATION_BUCKETS,
      registers: [registry],
    }),
    dbPoolConnections: new Gauge({
      name: "db_pool_connections",
      help: "Database pool connections by state",
      labelNames: ["service", "state"],
      registers: [registry],
    }),
    dbQueryDuration: new Histogram({
      name: "db_query_duration_seconds",
      help: "Database query duration in seconds, by logical operation",
      labelNames: ["service", "operation"],
      buckets: DURATION_BUCKETS,
      registers: [registry],
    }),
    cacheRequests: new Counter({
      name: "cache_requests_total",
      help: "In-process cache lookups by result",
      labelNames: ["service", "result"],
      registers: [registry],
    }),
    queueDepth: new Gauge({
      name: "queue_depth",
      help: "Unclaimed jobs in the queue",
      labelNames: ["queue"],
      registers: [registry],
    }),
    queueOldestJobAge: new Gauge({
      name: "queue_oldest_job_age_seconds",
      help: "Age of the oldest unclaimed job in seconds",
      labelNames: ["queue"],
      registers: [registry],
    }),
    settlementJobs: new Counter({
      name: "settlement_jobs_total",
      help: "Settlement job outcomes",
      labelNames: ["result"],
      registers: [registry],
    }),
    settlementBatchSize: new Histogram({
      name: "settlement_batch_size",
      help: "Rows claimed per settlement batch",
      buckets: BATCH_SIZE_BUCKETS,
      registers: [registry],
    }),
    buildInfo: new Gauge({
      name: "build_info",
      help: "Always 1; carries the running version so error onset can be correlated to a deploy",
      labelNames: ["service", "version", "commit"],
      registers: [registry],
    }),
  };

  metrics.buildInfo.set({ service: opts.service, version: opts.version, commit: opts.commit }, 1);
  return metrics;
}

/** Structurally typed so platform never has to import `pg`. */
export interface PoolLike {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
}

/** Reads the pool counters on every scrape rather than on every checkout. */
export function bindPoolMetrics(metrics: Metrics, pool: PoolLike): void {
  // Type assertion to work around TypeScript type limitations
  (metrics.dbPoolConnections as any).collect = () => {
    metrics.dbPoolConnections.set({ service: metrics.service, state: "idle" }, pool.idleCount);
    metrics.dbPoolConnections.set({ service: metrics.service, state: "busy" }, pool.totalCount - pool.idleCount);
    metrics.dbPoolConnections.set({ service: metrics.service, state: "waiting" }, pool.waitingCount);
  };
}
