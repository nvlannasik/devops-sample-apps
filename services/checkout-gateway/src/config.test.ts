import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.js";

const base = {
  ORDERS_API_URL: "http://orders-api:3000",
  WORKER_URL: "http://settlement-worker:3001",
};

test("every documented default is applied", () => {
  const c = loadConfig(base);
  assert.equal(c.downstreamTimeoutMs, 2000);
  assert.equal(c.cacheTtlSeconds, 30);
  assert.equal(c.cacheMaxEntries, 1000);
  assert.equal(c.ordersApiUrl, "http://orders-api:3000");
  assert.equal(c.workerUrl, "http://settlement-worker:3001");
});

test("both upstream URLs are required — the gateway cannot invent an address", () => {
  assert.throws(() => loadConfig({ WORKER_URL: base.WORKER_URL }), /ORDERS_API_URL/);
  assert.throws(() => loadConfig({ ORDERS_API_URL: base.ORDERS_API_URL }), /WORKER_URL/);
});

test("a URL that is not a URL fails at boot, not on the first request", () => {
  assert.throws(() => loadConfig({ ...base, ORDERS_API_URL: "orders-api:3000" }), /ORDERS_API_URL/);
});

test("a trailing slash is stripped so joined paths never double up", () => {
  const c = loadConfig({ ...base, ORDERS_API_URL: "http://orders-api:3000/" });
  assert.equal(c.ordersApiUrl, "http://orders-api:3000");
});

test("the fault knobs are readable from the environment", () => {
  const c = loadConfig({ ...base, DOWNSTREAM_TIMEOUT_MS: "50", CACHE_TTL_SECONDS: "0", CACHE_MAX_ENTRIES: "5" });
  assert.equal(c.downstreamTimeoutMs, 50);
  assert.equal(c.cacheTtlSeconds, 0);
  assert.equal(c.cacheMaxEntries, 5);
});