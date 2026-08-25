import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfigError } from "@sample-app/platform";
import { loadConfig } from "./config.js";

const base = { DB_HOST: "db", DB_USERNAME: "app", DB_PASSWORD: "pw" };

test("every documented default is applied", () => {
  const c = loadConfig(base);
  assert.equal(c.db.port, 5432);
  assert.equal(c.db.database, "sample_app");
  assert.equal(c.db.sslMode, "disable");
  assert.equal(c.dbPoolMax, 10);
  assert.equal(c.dbStatementTimeoutMs, 5000);
  assert.equal(c.migrationRequired, true);
  assert.equal(c.orderResponseVersion, 1);
  assert.equal(c.livenessChecksDb, false);
  assert.equal(c.port, 3000);
  assert.equal(c.gracefulShutdownMs, 10000);
});

test("DB_HOST is required", () => {
  assert.throws(() => loadConfig({}), (err: unknown) => {
    assert.ok(err instanceof ConfigError);
    assert.match((err as Error).message, /DB_HOST/);
    return true;
  });
});

test("the connection is read from the discrete DB_* variables", () => {
  const c = loadConfig({ ...base, DB_PORT: "6432", DB_NAME: "orders", DB_SSL_MODE: "require" });
  assert.deepEqual(c.db, {
    host: "db",
    port: 6432,
    user: "app",
    password: "pw",
    database: "orders",
    sslMode: "require",
  });
});

test("the fault knobs are readable from the environment", () => {
  const c = loadConfig({
    ...base,
    DB_POOL_MAX: "1",
    DB_STATEMENT_TIMEOUT_MS: "250",
    MIGRATION_REQUIRED: "false",
    ORDER_RESPONSE_VERSION: "2",
    LIVENESS_CHECKS_DB: "true",
  });
  assert.equal(c.dbPoolMax, 1);
  assert.equal(c.dbStatementTimeoutMs, 250);
  assert.equal(c.migrationRequired, false);
  assert.equal(c.orderResponseVersion, 2);
  assert.equal(c.livenessChecksDb, true);
});

test("DB_POOL_MAX must be at least 1", () => {
  assert.throws(() => loadConfig({ ...base, DB_POOL_MAX: "0" }), /DB_POOL_MAX/);
});

test("ORDER_RESPONSE_VERSION only accepts 1 or 2", () => {
  assert.throws(() => loadConfig({ ...base, ORDER_RESPONSE_VERSION: "3" }), /ORDER_RESPONSE_VERSION/);
});