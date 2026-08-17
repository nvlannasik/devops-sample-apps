import {
  Registry,
  Counter,
  Histogram,
  Gauge,
  collectDefaultMetrics,
} from "prom-client";

const HISTOGRAM_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

export interface MetricsRegistryOptions {
  service: string;
  version: string;
  commit?: string;
  defaultMetrics?: boolean;
}

export interface AppMetrics {
  registry: Registry;

  // HTTP server
  httpServerRequestsTotal: Counter;
  httpServerRequestDurationSeconds: Histogram;

  // HTTP client
  httpClientRequestsTotal: Counter;
  httpClientRequestDurationSeconds: Histogram;

  // DB pool + queries
  dbPoolConnections: Gauge;
  dbQueryDurationSeconds: Histogram;

  // Cache (checkout-gateway)
  cacheRequestsTotal: Counter;

  // Queue (settlement-worker)
  queueDepth: Gauge;
  queueOldestJobAgeSeconds: Gauge;
  settlementJobsTotal: Counter;
  settlementBatchSize: Histogram;

  // Build info
  buildInfo: Gauge;
}

export function createMetrics(opts: MetricsRegistryOptions): AppMetrics {
  const registry = new Registry();

  if (opts.defaultMetrics !== false) {
    collectDefaultMetrics({ register: registry });
  }

  const httpServerRequestsTotal = new Counter({
    name: "http_server_requests_total",
    help: "Total HTTP requests handled by this service",
    labelNames: ["service", "method", "route", "status"] as const,
    registers: [registry],
  });

  const httpServerRequestDurationSeconds = new Histogram({
    name: "http_server_request_duration_seconds",
    help: "HTTP server request duration in seconds",
    labelNames: ["service", "method", "route"] as const,
    buckets: HISTOGRAM_BUCKETS,
    registers: [registry],
  });

  const httpClientRequestsTotal = new Counter({
    name: "http_client_requests_total",
    help: "Total HTTP requests made by this service to peers",
    labelNames: ["service", "peer", "status"] as const,
    registers: [registry],
  });

  const httpClientRequestDurationSeconds = new Histogram({
    name: "http_client_request_duration_seconds",
    help: "HTTP client request duration in seconds",
    labelNames: ["service", "peer"] as const,
    buckets: HISTOGRAM_BUCKETS,
    registers: [registry],
  });

  const dbPoolConnections = new Gauge({
    name: "db_pool_connections",
    help: "DB pool connection counts by state",
    labelNames: ["service", "state"] as const,
    registers: [registry],
  });

  const dbQueryDurationSeconds = new Histogram({
    name: "db_query_duration_seconds",
    help: "DB query duration in seconds",
    labelNames: ["service", "operation"] as const,
    buckets: HISTOGRAM_BUCKETS,
    registers: [registry],
  });

  const cacheRequestsTotal = new Counter({
    name: "cache_requests_total",
    help: "Cache hit/miss counts",
    labelNames: ["service", "result"] as const,
    registers: [registry],
  });

  const queueDepth = new Gauge({
    name: "queue_depth",
    help: "Current number of pending settlement jobs",
    labelNames: ["queue"] as const,
    registers: [registry],
  });

  const queueOldestJobAgeSeconds = new Gauge({
    name: "queue_oldest_job_age_seconds",
    help: "Age of the oldest pending settlement job in seconds",
    labelNames: ["queue"] as const,
    registers: [registry],
  });

  const settlementJobsTotal = new Counter({
    name: "settlement_jobs_total",
    help: "Settlement job outcomes",
    labelNames: ["result"] as const,
    registers: [registry],
  });

  const settlementBatchSize = new Histogram({
    name: "settlement_batch_size",
    help: "Number of jobs claimed per settlement batch",
    buckets: [1, 5, 10, 25, 50, 100, 250, 500],
    registers: [registry],
  });

  // build_info is always 1; the labels carry the signal
  const buildInfo = new Gauge({
    name: "build_info",
    help: "Build metadata (always 1)",
    labelNames: ["service", "version", "commit"] as const,
    registers: [registry],
  });
  buildInfo
    .labels(opts.service, opts.version, opts.commit ?? opts.version)
    .set(1);

  return {
    registry,
    httpServerRequestsTotal,
    httpServerRequestDurationSeconds,
    httpClientRequestsTotal,
    httpClientRequestDurationSeconds,
    dbPoolConnections,
    dbQueryDurationSeconds,
    cacheRequestsTotal,
    queueDepth,
    queueOldestJobAgeSeconds,
    settlementJobsTotal,
    settlementBatchSize,
    buildInfo,
  };
}
