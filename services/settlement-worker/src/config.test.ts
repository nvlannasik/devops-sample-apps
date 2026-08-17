import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.js";

const base = { DATABASE_URL: "postgres://app:pw@db:5432/sample_app" };

test("every documented default is applied", () => {
  const c = loadConfig(base);
  assert.equal(c.dbPoolMax, 5);
  assert.equal(c.batchSize, 50);
  assert.equal(c.pollIntervalMs, 1000);
  assert.equal(c.maxAttempts, 3);
  assert.equal(c.verbosePayload, false);
});

test("DATABASE_URL is required", () => {
  assert.throws(() => loadConfig({}), /DATABASE_URL/);
});

test("the fault knobs are readable from the environment", () => {
  const c = loadConfig({
    ...base,
    SETTLEMENT_BATCH_SIZE: "200000",
    SETTLEMENT_POLL_INTERVAL_MS: "60000",
    SETTLEMENT_MAX_ATTEMPTS: "1",
    VERBOSE_PAYLOAD: "true",
    DB_POOL_MAX: "1",
  });
  assert.equal(c.batchSize, 200000);
  assert.equal(c.pollIntervalMs, 60000);
  assert.equal(c.maxAttempts, 1);
  assert.equal(c.verbosePayload, true);
  assert.equal(c.dbPoolMax, 1);
});

test("a batch size of zero is rejected — a worker that claims nothing is a silent outage", () => {
  assert.throws(() => loadConfig({ ...base, SETTLEMENT_BATCH_SIZE: "0" }), /SETTLEMENT_BATCH_SIZE/);
});