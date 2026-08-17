import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { createLogger } from "@sample-app/platform";
import { pendingMigrations, migrationFiles, runMigrations, appliedVersions, assertSchemaCurrent } from "./migrate.js";

const DB = process.env["TEST_DATABASE_URL"];
const quiet = createLogger({ service: "orders-api", version: "test", level: "error", write: () => {} });

test("pendingMigrations returns unapplied .sql files in lexical order", () => {
  const files = ["002_settlement_jobs.sql", "001_orders.sql", "README.md"];
  assert.deepEqual(pendingMigrations(files, new Set()), ["001_orders.sql", "002_settlement_jobs.sql"]);
});

test("pendingMigrations is empty once everything is applied — running twice is a no-op", () => {
  const files = ["001_orders.sql", "002_settlement_jobs.sql"];
  assert.deepEqual(pendingMigrations(files, new Set(files)), []);
});

test("migrationFiles finds the migrations shipped in db/migrations", () => {
  assert.deepEqual(migrationFiles(), ["001_orders.sql", "002_settlement_jobs.sql"]);
});

test("runMigrations creates the schema and is idempotent", { skip: !DB }, async () => {
  const pool = new pg.Pool({ connectionString: DB });
  try {
    await pool.query("DROP TABLE IF EXISTS settlement_jobs, orders, schema_migrations CASCADE");
    await runMigrations(pool, quiet);
    assert.deepEqual([...(await appliedVersions(pool))].sort(), migrationFiles());

    const before = await pool.query("SELECT count(*)::int AS n FROM schema_migrations");
    await runMigrations(pool, quiet);
    const after = await pool.query("SELECT count(*)::int AS n FROM schema_migrations");
    assert.equal(after.rows[0].n, before.rows[0].n);

    const cols = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'settlement_jobs'",
    );
    assert.ok(cols.rows.some((r: { column_name: string }) => r.column_name === "traceparent"));
  } finally {
    await pool.end();
  }
});

test("assertSchemaCurrent throws when a migration has not been applied", { skip: !DB }, async () => {
  const pool = new pg.Pool({ connectionString: DB });
  try {
    await runMigrations(pool, quiet);
    await pool.query("DELETE FROM schema_migrations WHERE version = $1", ["002_settlement_jobs.sql"]);
    await assert.rejects(assertSchemaCurrent(pool, quiet), /002_settlement_jobs\.sql/);
    await runMigrations(pool, quiet);
    await assertSchemaCurrent(pool, quiet);
  } finally {
    await pool.end();
  }
});