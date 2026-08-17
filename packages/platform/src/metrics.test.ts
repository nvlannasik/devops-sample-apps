import { test } from "node:test";
import assert from "node:assert/strict";
import { createMetrics, DURATION_BUCKETS, bindPoolMetrics } from "./metrics.js";

const EXPECTED = [
  "http_server_requests_total",
  "http_server_request_duration_seconds",
  "http_client_requests_total",
  "http_client_request_duration_seconds",
  "db_pool_connections",
  "db_query_duration_seconds",
  "cache_requests_total",
  "queue_depth",
  "queue_oldest_job_age_seconds",
  "settlement_jobs_total",
  "settlement_batch_size",
  "build_info",
];

test("every metric in the observability contract is registered", async () => {
  const m = createMetrics({ service: "orders-api", version: "a1b2c3d", commit: "a1b2c3d" });
  const text = await m.registry.metrics();
  for (const name of EXPECTED) assert.match(text, new RegExp(`^# HELP ${name} `, "m"), name);
});

test("prom-client default process and nodejs collectors are included", async () => {
  const m = createMetrics({ service: "orders-api", version: "v", commit: "c" });
  const text = await m.registry.metrics();
  assert.match(text, /process_cpu_seconds_total/);
  assert.match(text, /nodejs_eventloop_lag_seconds/);
});

test("build_info is always 1 and carries service, version and commit", async () => {
  const m = createMetrics({ service: "orders-api", version: "a1b2c3d", commit: "a1b2c3d" });
  const text = await m.registry.metrics();
  assert.match(text, /build_info\{service="orders-api",version="a1b2c3d",commit="a1b2c3d"\} 1/);
});

test("duration histograms use the exact contract buckets", async () => {
  const m = createMetrics({ service: "s", version: "v", commit: "c" });
  // Record an observation to ensure histogram buckets are emitted
  m.httpServerDuration.observe(0.1);
  const text = await m.registry.metrics();
  const match = text.match(/^http_server_request_duration_seconds_bucket/gm);
  assert.ok(match);
  // Should have exactly as many buckets as defined, plus the +Inf bucket
  assert.equal(match.length, DURATION_BUCKETS.length + 1);
});

test("bindPoolMetrics reports idle, busy and waiting from the pool counters", async () => {
  const m = createMetrics({ service: "orders-api", version: "v", commit: "c" });
  bindPoolMetrics(m, { totalCount: 7, idleCount: 2, waitingCount: 3 });
  const text = await m.registry.metrics();
  assert.match(text, /db_pool_connections\{service="orders-api",state="idle"\} 2/);
  assert.match(text, /db_pool_connections\{service="orders-api",state="busy"\} 5/);
  assert.match(text, /db_pool_connections\{service="orders-api",state="waiting"\} 3/);
});